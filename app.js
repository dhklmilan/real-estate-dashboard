/**
 * app.js
 * -----------------------------------------------------------------------
 * Leaflet initialization, GeoJSON binding, sidebar synchronization,
 * filters, base-layer switching, and a client-side admin panel
 * (login, add/edit/delete property, image upload, draw-on-map geometry).
 *
 * IMPORTANT — HONEST SECURITY NOTE:
 * This is a static site with no server. The "admin login" below is a
 * convenience gate implemented entirely in client-side JavaScript. It
 * keeps casual visitors from editing listings, but it is NOT secure:
 * anyone who opens browser dev tools can read the password constant or
 * bypass the check entirely. Do not use this to protect anything
 * sensitive. True access control requires a server/backend.
 * -----------------------------------------------------------------------
 */

(function () {
  "use strict";

  // ------------------------------------------------------------------
  // CONFIG
  // ------------------------------------------------------------------
  var ADMIN_PASSWORD = "meridian2026"; // change this — see security note above
  var STORAGE_KEY_PROPERTIES = "meridianEstates.properties.v1";
  var STORAGE_KEY_ADMIN = "meridianEstates.isAdmin.v1";
  var MAX_IMAGES = 5;              // hard cap on photos per property
  var IMAGE_MAX_DIMENSION = 1280;  // longest side, px — keeps localStorage usage sane
  var IMAGE_JPEG_QUALITY = 0.75;

  // Zoom level at which a Land polygon switches from a simplified bounding
  // box "rectangle" (low zoom, easier to see/click when it's small on
  // screen) to its real, drawn shape (high zoom, once there's room to show
  // detail). This is the ONLY number that controls the switch — kept as a
  // single shared constant so the transition happens at the exact same
  // zoom level for every polygon feature, everywhere it's checked.
  var SHAPE_DETAIL_ZOOM_THRESHOLD = 17;

  // Minimum on-screen size (px) for a Land parcel's low-zoom rectangle.
  // A tiny parcel's true geographic bounding box can shrink to a sliver
  // when zoomed out — this pads it so it stays as visible as the fixed
  // 9px-radius circle markers used for Residential points.
  var MIN_RECT_PIXEL_WIDTH = 34;
  var MIN_RECT_PIXEL_HEIGHT = 24;

  var STATUS_COLORS = {
    Available: "#10B981",
    Sold: "#F4735B"
  };

  var PLACEHOLDER_IMAGE =
    "data:image/svg+xml;utf8," +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200">' +
        '<rect width="100%" height="100%" fill="#E2E8F0"/>' +
        '<text x="50%" y="50%" font-family="Arial, sans-serif" font-size="15" ' +
        'fill="#64748B" text-anchor="middle" dominant-baseline="middle">No Image</text>' +
        "</svg>"
    );

  // ------------------------------------------------------------------
  // STATE
  // ------------------------------------------------------------------
  var map;
  var geoJsonLayer;
  var tempPreviewLayer;         // shows the shape currently being drawn, before save
  var activeDrawHandler = null; // the live L.Draw.Marker / L.Draw.Polygon instance

  var properties = [];          // mutable working set of GeoJSON features
  var layersById = {};          // id -> Leaflet layer, for sidebar <-> map sync
  var polygonLayers = [];       // Polygon-type layers currently on the map, for zoom-based shape swapping

  var currentStatusFilter = "All";
  var currentTypeFilter = "All";

  var isAdmin = false;
  var editingPropertyId = null; // null = "add" mode, otherwise the id being edited
  var pendingGeometry = null;   // geometry captured via the draw tool for the open form
  var pendingImages = [];       // up to MAX_IMAGES data-URLs for the open form
  var confirmCallback = null;

  // ------------------------------------------------------------------
  // INIT
  // ------------------------------------------------------------------
  document.addEventListener("DOMContentLoaded", init);

  function init() {
    loadProperties();
    initMap();
    bindFilterButtons();
    bindAdminUI();
    bindModalGenerics();
    bindResizeHandling();
    restoreAdminSession();
    renderAll();
    fitMapToAllProperties(false); // initial view: zoom out to show every property
  }

  // ------------------------------------------------------------------
  // DATA PERSISTENCE (localStorage)
  // ------------------------------------------------------------------
  function loadProperties() {
    var stored = null;
    try {
      stored = localStorage.getItem(STORAGE_KEY_PROPERTIES);
    } catch (e) {
      stored = null;
    }

    if (stored) {
      try {
        properties = JSON.parse(stored);
        return;
      } catch (e) {
        // fall through to reseed if stored data is corrupt
      }
    }

    // First run (or corrupt storage): seed from properties.js, then persist.
    properties = JSON.parse(JSON.stringify(realEstateData.features));
    saveProperties();
  }

  function saveProperties() {
    try {
      localStorage.setItem(STORAGE_KEY_PROPERTIES, JSON.stringify(properties));
    } catch (e) {
      console.error("Could not save properties to localStorage:", e);
    }
  }

  function restoreAdminSession() {
    var flag = null;
    try {
      flag = localStorage.getItem(STORAGE_KEY_ADMIN);
    } catch (e) {
      flag = null;
    }
    if (flag === "true") {
      setAdminMode(true);
    }
  }

  // ------------------------------------------------------------------
  // MAP INIT + BASE LAYERS
  // ------------------------------------------------------------------
  function initMap() {
    map = L.map("map", {
      zoomControl: true,
      scrollWheelZoom: true
    }).setView([40.0200, -105.2775], 15);

    var streetsLight = L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
      {
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: "abcd",
        maxZoom: 20
      }
    );

    var streetsOSM = L.tileLayer(
      "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        subdomains: "abc",
        maxZoom: 19
      }
    );

    var satellite = L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      {
        attribution:
          "Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community",
        maxZoom: 19
      }
    );

    streetsLight.addTo(map);

    var baseLayers = {
      "Streets (Light)": streetsLight,
      "Streets (OSM)": streetsOSM,
      "Satellite": satellite
    };

    L.control.layers(baseLayers, null, { position: "topright", collapsed: true }).addTo(map);

    // Group used only to preview a shape while it's being drawn (before save).
    tempPreviewLayer = L.featureGroup().addTo(map);

    // Fires whenever an admin finishes drawing a marker or polygon.
    map.on(L.Draw.Event.CREATED, onDrawCreated);

    // Swap each Land polygon between its bounding-box rectangle and its
    // real shape as the user zooms past SHAPE_DETAIL_ZOOM_THRESHOLD.
    map.on("zoomend", updateAllPolygonShapes);

    // Robust fix for the "blank map on mobile" issue: re-measure the
    // instant the map's actual container size changes, for any reason.
    setTimeout(function () { map.invalidateSize(); }, 200);
    setTimeout(function () { map.invalidateSize(); }, 800);
    window.addEventListener("load", function () { map.invalidateSize(); });

    if ("ResizeObserver" in window) {
      var mapEl = document.getElementById("map");
      var ro = new ResizeObserver(function () { map.invalidateSize(); });
      ro.observe(mapEl);
    }
  }

  // Zooms/pans so every property (not just the currently-filtered ones) is
  // visible. Used once on initial load, and again right after a new
  // property is added, so the view always "zooms out" to include it.
  // Nothing else about the map (markers, click-to-focus, popups) is touched.
  function fitMapToAllProperties(animate) {
    if (!properties.length) return;
    var tempLayer = L.geoJSON({ type: "FeatureCollection", features: properties });
    var bounds = tempLayer.getBounds();
    if (bounds.isValid()) {
      map.fitBounds(bounds, { padding: [50, 50], maxZoom: 16, animate: animate !== false });
    }
  }

  function bindResizeHandling() {
    window.addEventListener("resize", function () { map.invalidateSize(); });
    window.addEventListener("orientationchange", function () {
      setTimeout(function () { map.invalidateSize(); }, 300);
    });
  }

  // ------------------------------------------------------------------
  // ZOOM-DEPENDENT POLYGON DETAIL (rectangle at low zoom, real shape at high zoom)
  // ------------------------------------------------------------------

  // True while the map is zoomed out past the switch point.
  function isLowZoom() {
    return map.getZoom() < SHAPE_DETAIL_ZOOM_THRESHOLD;
  }

  // Bounding-box ring (GeoJSON [lng,lat] winding, closed) for a Polygon
  // geometry's outer ring — this becomes the simplified "rectangle" shape.
  function computeBoundingBoxRing(geometry) {
    var ring = geometry.coordinates[0];
    var minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
    ring.forEach(function (c) {
      if (c[0] < minLng) minLng = c[0];
      if (c[0] > maxLng) maxLng = c[0];
      if (c[1] < minLat) minLat = c[1];
      if (c[1] > maxLat) maxLat = c[1];
    });
    return [
      [minLng, minLat],
      [maxLng, minLat],
      [maxLng, maxLat],
      [minLng, maxLat],
      [minLng, minLat]
    ];
  }

  // GeoJSON rings are [lng,lat]; Leaflet's setLatLngs wants LatLng objects.
  function ringToLatLngs(ring) {
    return ring.map(function (c) { return L.latLng(c[1], c[0]); });
  }

  // Takes a raw geographic bounding-box ring and pads it — in pixel space,
  // at the current zoom — so it never renders smaller than
  // MIN_RECT_PIXEL_WIDTH x MIN_RECT_PIXEL_HEIGHT on screen. The rectangle
  // grows toward its true geographic size as the map zooms in, and never
  // shrinks below the minimum, so small parcels stay visible instead of
  // getting lost against the basemap.
  function computeVisibleRectangleLatLngs(boundingBoxRing) {
    var minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
    boundingBoxRing.forEach(function (c) {
      if (c[0] < minLng) minLng = c[0];
      if (c[0] > maxLng) maxLng = c[0];
      if (c[1] < minLat) minLat = c[1];
      if (c[1] > maxLat) maxLat = c[1];
    });

    var zoom = map.getZoom();
    var swPoint = map.project(L.latLng(minLat, minLng), zoom);
    var nePoint = map.project(L.latLng(maxLat, maxLng), zoom);

    var pixelWidth = Math.abs(nePoint.x - swPoint.x);
    var pixelHeight = Math.abs(swPoint.y - nePoint.y); // screen y is inverted vs. lat

    var centerPoint = L.point((swPoint.x + nePoint.x) / 2, (swPoint.y + nePoint.y) / 2);
    var halfW = Math.max(pixelWidth / 2, MIN_RECT_PIXEL_WIDTH / 2);
    var halfH = Math.max(pixelHeight / 2, MIN_RECT_PIXEL_HEIGHT / 2);

    var nw = map.unproject(L.point(centerPoint.x - halfW, centerPoint.y - halfH), zoom);
    var se = map.unproject(L.point(centerPoint.x + halfW, centerPoint.y + halfH), zoom);

    return [
      L.latLng(nw.lat, nw.lng),
      L.latLng(nw.lat, se.lng),
      L.latLng(se.lat, se.lng),
      L.latLng(se.lat, nw.lng),
      L.latLng(nw.lat, nw.lng)
    ];
  }

  // Applies the correct shape to one polygon layer for the current zoom.
  // Cheap and idempotent (just re-sets coordinates on the existing layer),
  // so it never disturbs that layer's style, popup, or event bindings —
  // the transition is a clean swap in place, not a teardown/rebuild, so
  // hover state, open popups, and the sidebar stay in sync.
  function applyShapeForZoom(layer) {
    var target = isLowZoom()
      ? computeVisibleRectangleLatLngs(layer._boundingBoxRing)
      : layer._actualLatLngs;
    layer.setLatLngs(target);
  }

  function updateAllPolygonShapes() {
    polygonLayers.forEach(applyShapeForZoom);
  }

  // ------------------------------------------------------------------
  // RENDER PIPELINE
  // ------------------------------------------------------------------
  function renderAll() {
    renderGeoJson();
    renderListings();
  }

  function getFilteredFeatures() {
    return properties.filter(function (feature) {
      var statusOk = currentStatusFilter === "All" || feature.properties.status === currentStatusFilter;
      var typeOk = currentTypeFilter === "All" || feature.properties.type === currentTypeFilter;
      return statusOk && typeOk;
    });
  }

  function renderGeoJson() {
    if (geoJsonLayer) {
      map.removeLayer(geoJsonLayer);
    }
    layersById = {};
    polygonLayers = [];

    var collection = { type: "FeatureCollection", features: getFilteredFeatures() };

    geoJsonLayer = L.geoJSON(collection, {
      style: styleFeature,
      pointToLayer: pointToLayer,
      onEachFeature: onEachFeature
    }).addTo(map);
  }

  function styleFeature(feature) {
    var color = STATUS_COLORS[feature.properties.status] || "#64748B";
    return {
      color: color,
      weight: 2,
      opacity: 0.9,
      fillColor: color,
      fillOpacity: 0.22
    };
  }

  function pointToLayer(feature, latlng) {
    var color = STATUS_COLORS[feature.properties.status] || "#64748B";
    return L.circleMarker(latlng, {
      radius: 9,
      color: "#ffffff",
      weight: 2,
      fillColor: color,
      fillOpacity: 0.95
    });
  }

  function onEachFeature(feature, layer) {
    var props = feature.properties;
    layersById[props.id] = layer;

    // Land parcels get the low-zoom rectangle / high-zoom real-shape swap.
    if (feature.geometry.type === "Polygon") {
      layer._actualLatLngs = ringToLatLngs(feature.geometry.coordinates[0]);
      layer._boundingBoxRing = computeBoundingBoxRing(feature.geometry); // raw, unpadded — padding is applied per-zoom
      polygonLayers.push(layer);
      applyShapeForZoom(layer); // set the correct shape immediately, at creation
    }

    layer.bindPopup(buildPopupHtml(props));

    layer.on({
      mouseover: function (e) { highlightLayer(e.target, feature); },
      mouseout: function (e) { resetLayerStyle(e.target, feature); },
      click: function () { focusFeature(props.id); }
    });

    layer.on("popupopen", function () { bindPopupActionButtons(props.id); });
  }

  function highlightLayer(layer, feature) {
    if (feature.geometry.type === "Polygon") {
      layer.setStyle({ weight: 4, fillOpacity: 0.35 });
      if (layer.bringToFront) layer.bringToFront();
    } else {
      layer.setStyle({ radius: 12, weight: 3 });
    }
  }

  function resetLayerStyle(layer, feature) {
    if (feature.geometry.type === "Polygon") {
      layer.setStyle(styleFeature(feature));
    } else {
      layer.setStyle({ radius: 9, weight: 2 });
    }
  }

  // ------------------------------------------------------------------
  // POPUP + CARD MARKUP
  // ------------------------------------------------------------------

  // Backward compatible: older/seed listings only have a single imageUrl.
  function getImages(props) {
    if (props.images && props.images.length) return props.images;
    if (props.imageUrl) return [props.imageUrl];
    return [PLACEHOLDER_IMAGE];
  }

  // Small thumbnail strip shown only when a listing has more than one photo.
  // Clicking a thumbnail swaps the main image — no extra state needed since
  // each thumbnail's own src is the full-size image.
  function buildGalleryHtml(images) {
    if (images.length <= 1) return "";
    var thumbs = images.slice(0, MAX_IMAGES).map(function (src, i) {
      return '<img class="gallery-thumb' + (i === 0 ? " active" : "") + '" src="' + src + '" data-gallery-thumb alt="Photo ' + (i + 1) + '" />';
    }).join("");
    return '<div class="gallery-strip">' + thumbs + "</div>";
  }

  function wireGalleryThumbs(container) {
    if (!container) return;
    container.querySelectorAll("[data-gallery-thumb]").forEach(function (thumb) {
      thumb.addEventListener("click", function (e) {
        e.stopPropagation();
        var mainImg = container.querySelector("[data-main-image]");
        if (mainImg) mainImg.src = thumb.src;
        container.querySelectorAll("[data-gallery-thumb]").forEach(function (t) {
          t.classList.toggle("active", t === thumb);
        });
      });
    });
  }

  // Renders the description as its own block, separate from the
  // price/type/size meta row. Omitted entirely when there isn't one, so
  // older listings without a description don't show empty space.
  function buildDescriptionHtml(props) {
    if (!props.description) return "";
    return '<div class="card-description">' + escapeHtml(props.description) + "</div>";
  }

  function buildPopupHtml(props) {
    var images = getImages(props);
    var adminActions = isAdmin
      ? '<div class="card-admin-actions">' +
          '<button class="icon-btn" data-popup-edit-id="' + props.id + '">Edit</button>' +
          '<button class="icon-btn icon-btn-danger" data-popup-delete-id="' + props.id + '">Delete</button>' +
        "</div>"
      : "";

    return (
      '<div class="popup-card">' +
        '<img class="card-image" data-main-image src="' + images[0] + '" alt="' + escapeHtml(props.title) + '" />' +
        buildGalleryHtml(images) +
        '<div class="card-body">' +
          '<div class="card-top-row">' +
            '<div class="card-title">' + escapeHtml(props.title) + "</div>" +
            '<span class="status-badge ' + props.status + '">' + props.status + "</span>" +
          "</div>" +
          '<div class="card-price">' + escapeHtml(props.price) + "</div>" +
          '<div class="card-meta">' +
            '<span class="type-pill">' + escapeHtml(props.type) + '</span>' +
            '<span class="dot"></span>' +
            '<span>' + escapeHtml(props.size) + '</span>' +
          "</div>" +
          buildDescriptionHtml(props) +
          adminActions +
        "</div>" +
      "</div>"
    );
  }

  function bindPopupActionButtons(id) {
    var editBtn = document.querySelector('[data-popup-edit-id="' + cssEscape(id) + '"]');
    var deleteBtn = document.querySelector('[data-popup-delete-id="' + cssEscape(id) + '"]');
    if (editBtn) {
      editBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        openPropertyForm(id);
      });
    }
    if (deleteBtn) {
      deleteBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        confirmDelete(id);
      });
    }
    var popupEl = editBtn ? editBtn.closest(".popup-card") : (deleteBtn ? deleteBtn.closest(".popup-card") : null);
    if (!popupEl) {
      // Fall back to searching any open popup for the gallery strip.
      popupEl = document.querySelector(".leaflet-popup-content .popup-card");
    }
    wireGalleryThumbs(popupEl);
  }

  function escapeHtml(str) {
    var div = document.createElement("div");
    div.textContent = str == null ? "" : String(str);
    return div.innerHTML;
  }

  // Minimal CSS.escape fallback for building attribute selectors safely.
  function cssEscape(str) {
    return String(str).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  // ------------------------------------------------------------------
  // SIDEBAR LISTINGS
  // ------------------------------------------------------------------
  function renderListings() {
    var container = document.getElementById("listings-container");
    container.innerHTML = "";

    var visibleFeatures = getFilteredFeatures();

    document.getElementById("listings-count").textContent =
      visibleFeatures.length + (visibleFeatures.length === 1 ? " property" : " properties");

    if (visibleFeatures.length === 0) {
      var empty = document.createElement("p");
      empty.className = "modal-hint";
      empty.style.padding = "4px 4px";
      empty.textContent = "No properties match the current filters.";
      container.appendChild(empty);
      return;
    }

    visibleFeatures.forEach(function (feature) {
      var props = feature.properties;
      var images = getImages(props);
      var card = document.createElement("div");
      card.className = "property-card";
      card.dataset.id = props.id;

      var adminActions = isAdmin
        ? '<div class="card-admin-actions">' +
            '<button class="icon-btn" data-edit-id="' + props.id + '">Edit</button>' +
            '<button class="icon-btn icon-btn-danger" data-delete-id="' + props.id + '">Delete</button>' +
          "</div>"
        : "";

      card.innerHTML =
        '<img class="card-image" data-main-image src="' + images[0] + '" alt="' + escapeHtml(props.title) + '" />' +
        buildGalleryHtml(images) +
        '<div class="card-body">' +
          '<div class="card-top-row">' +
            '<div class="card-title">' + escapeHtml(props.title) + "</div>" +
            '<span class="status-badge ' + props.status + '">' + props.status + "</span>" +
          "</div>" +
          '<div class="card-price">' + escapeHtml(props.price) + "</div>" +
          '<div class="card-meta">' +
            '<span class="type-pill">' + escapeHtml(props.type) + '</span>' +
            '<span class="dot"></span>' +
            '<span>' + escapeHtml(props.size) + '</span>' +
          "</div>" +
          buildDescriptionHtml(props) +
          adminActions +
        "</div>";

      card.addEventListener("click", function (e) {
        if (e.target.closest("[data-edit-id]") || e.target.closest("[data-delete-id]")) return;
        if (e.target.closest("[data-gallery-thumb]")) return;
        focusFeature(props.id);
      });

      var editBtn = card.querySelector("[data-edit-id]");
      var deleteBtn = card.querySelector("[data-delete-id]");
      if (editBtn) {
        editBtn.addEventListener("click", function (e) {
          e.stopPropagation();
          openPropertyForm(props.id);
        });
      }
      if (deleteBtn) {
        deleteBtn.addEventListener("click", function (e) {
          e.stopPropagation();
          confirmDelete(props.id);
        });
      }
      wireGalleryThumbs(card);

      container.appendChild(card);
    });
  }

  // ------------------------------------------------------------------
  // CROSS-LINKING: SIDEBAR <-> MAP
  // ------------------------------------------------------------------
  function focusFeature(id) {
    var layer = layersById[id];
    if (!layer) return;

    if (layer.getBounds) {
      map.fitBounds(layer.getBounds(), { maxZoom: 17, padding: [60, 60] });
    } else if (layer.getLatLng) {
      map.setView(layer.getLatLng(), 17, { animate: true });
    }

    layer.openPopup();
    setActiveCard(id);
  }

  function setActiveCard(id) {
    var cards = document.querySelectorAll(".property-card");
    cards.forEach(function (card) {
      card.classList.toggle("card-active", card.dataset.id === id);
    });
  }

  // ------------------------------------------------------------------
  // FILTER BUTTONS
  // ------------------------------------------------------------------
  function bindFilterButtons() {
    var statusButtons = document.querySelectorAll('#filter-bar .filter-btn');
    statusButtons.forEach(function (btn) {
      btn.addEventListener("click", function () {
        statusButtons.forEach(function (b) { b.classList.remove("active"); });
        btn.classList.add("active");
        currentStatusFilter = btn.dataset.filter;
        renderAll();
      });
    });

    var typeButtons = document.querySelectorAll('#type-filter-bar .filter-chip');
    typeButtons.forEach(function (btn) {
      btn.addEventListener("click", function () {
        typeButtons.forEach(function (b) { b.classList.remove("active"); });
        btn.classList.add("active");
        currentTypeFilter = btn.dataset.typeFilter;
        renderAll();
      });
    });
  }

  // ==================================================================
  // ADMIN: LOGIN / LOGOUT
  // ==================================================================
  function bindAdminUI() {
    document.getElementById("admin-toggle-btn").addEventListener("click", function () {
      if (isAdmin) return; // logging out happens via the dedicated button in the admin bar
      openModal("login-modal");
      document.getElementById("login-password").value = "";
      document.getElementById("login-error").classList.add("hidden");
      document.getElementById("login-password").focus();
    });

    document.getElementById("login-submit-btn").addEventListener("click", attemptLogin);
    document.getElementById("login-password").addEventListener("keydown", function (e) {
      if (e.key === "Enter") attemptLogin();
    });

    document.getElementById("logout-btn").addEventListener("click", function () {
      setAdminMode(false);
    });

    document.getElementById("add-property-btn").addEventListener("click", function () {
      openPropertyForm(null);
    });

    bindPropertyFormUI();
  }

  function attemptLogin() {
    var input = document.getElementById("login-password").value;
    if (input === ADMIN_PASSWORD) {
      setAdminMode(true);
      closeModal("login-modal");
    } else {
      document.getElementById("login-error").classList.remove("hidden");
    }
  }

  function setAdminMode(value) {
    isAdmin = value;
    try {
      if (value) {
        localStorage.setItem(STORAGE_KEY_ADMIN, "true");
      } else {
        localStorage.removeItem(STORAGE_KEY_ADMIN);
      }
    } catch (e) { /* ignore storage errors */ }

    document.getElementById("admin-bar").classList.toggle("hidden", !value);
    document.getElementById("admin-toggle-btn").classList.toggle("is-active", value);
    renderAll();
  }

  // ==================================================================
  // ADMIN: ADD / EDIT PROPERTY FORM
  // ==================================================================
  function bindPropertyFormUI() {
    // Segmented Type / Status toggles
    bindSegmented("field-type", function () {
      // Changing type invalidates any already-drawn geometry, since a
      // Land parcel is a polygon and a Residential listing is a point.
      pendingGeometry = null;
      updateGeometryStatus();
    });
    bindSegmented("field-status", function () {});

    document.getElementById("draw-geometry-btn").addEventListener("click", startDrawing);

    document.getElementById("field-image").addEventListener("change", function (e) {
      var files = Array.prototype.slice.call(e.target.files || []);
      e.target.value = ""; // always clear, so picking the same file again later still fires "change"
      if (!files.length) return;

      var remaining = MAX_IMAGES - pendingImages.length;
      if (remaining <= 0) {
        renderImagePreviewGrid();
        return;
      }

      files.slice(0, remaining).forEach(function (file) {
        readAndCompressImage(file, function (dataUrl) {
          if (!dataUrl) return;
          if (pendingImages.length >= MAX_IMAGES) return; // guard against async race past the cap
          pendingImages.push(dataUrl);
          renderImagePreviewGrid();
        });
      });
    });

    document.getElementById("image-preview-grid").addEventListener("click", function (e) {
      var btn = e.target.closest("[data-remove-image-idx]");
      if (!btn) return;
      var idx = parseInt(btn.dataset.removeImageIdx, 10);
      pendingImages.splice(idx, 1);
      renderImagePreviewGrid();
    });

    document.getElementById("save-property-btn").addEventListener("click", saveProperty);

    document.getElementById("delete-property-btn").addEventListener("click", function () {
      if (editingPropertyId) confirmDelete(editingPropertyId);
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && activeDrawHandler) {
        cancelDrawing();
      }
    });
  }

  // Resizes/compresses an uploaded photo via canvas before it's stored as a
  // data URL, so up to MAX_IMAGES photos per property stay well within
  // localStorage limits. Falls back to the raw file if canvas isn't usable.
  function readAndCompressImage(file, callback) {
    var reader = new FileReader();
    reader.onload = function (evt) {
      var img = new Image();
      img.onload = function () {
        try {
          var scale = Math.min(1, IMAGE_MAX_DIMENSION / Math.max(img.width, img.height));
          var w = Math.max(1, Math.round(img.width * scale));
          var h = Math.max(1, Math.round(img.height * scale));
          var canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          canvas.getContext("2d").drawImage(img, 0, 0, w, h);
          callback(canvas.toDataURL("image/jpeg", IMAGE_JPEG_QUALITY));
        } catch (err) {
          callback(evt.target.result); // canvas failed — keep the original
        }
      };
      img.onerror = function () { callback(evt.target.result); };
      img.src = evt.target.result;
    };
    reader.onerror = function () { callback(null); };
    reader.readAsDataURL(file);
  }

  function renderImagePreviewGrid() {
    var grid = document.getElementById("image-preview-grid");
    grid.innerHTML = "";
    pendingImages.forEach(function (src, idx) {
      var item = document.createElement("div");
      item.className = "image-preview-item";
      item.innerHTML =
        '<img src="' + src + '" alt="Photo ' + (idx + 1) + '" />' +
        '<button type="button" class="image-preview-remove" data-remove-image-idx="' + idx + '" title="Remove photo">&times;</button>';
      grid.appendChild(item);
    });

    var note = document.getElementById("image-limit-note");
    note.classList.toggle("hidden", pendingImages.length < MAX_IMAGES);

    document.getElementById("field-image").disabled = pendingImages.length >= MAX_IMAGES;
  }

  function bindSegmented(containerId, onChange) {
    var container = document.getElementById(containerId);
    var buttons = container.querySelectorAll(".segmented-btn");
    buttons.forEach(function (btn) {
      btn.addEventListener("click", function () {
        buttons.forEach(function (b) { b.classList.remove("active"); });
        btn.classList.add("active");
        onChange();
      });
    });
  }

  function getSegmentedValue(containerId) {
    var active = document.querySelector("#" + containerId + " .segmented-btn.active");
    return active ? active.dataset.value : null;
  }

  function setSegmentedValue(containerId, value) {
    var buttons = document.querySelectorAll("#" + containerId + " .segmented-btn");
    buttons.forEach(function (b) {
      b.classList.toggle("active", b.dataset.value === value);
    });
  }

  // Guarded read/write for optional form fields — if a field doesn't exist
  // in the HTML yet, these no-op instead of throwing, so one missing
  // element can never block the whole modal from opening.
  function getFieldValue(id) {
    var el = document.getElementById(id);
    return el ? el.value : "";
  }

  function setFieldValue(id, value) {
    var el = document.getElementById(id);
    if (el) el.value = value;
  }

  function openPropertyForm(idOrNull) {
    editingPropertyId = idOrNull;
    pendingGeometry = null;
    pendingImages = [];
    tempPreviewLayer.clearLayers();

    document.getElementById("property-form-error").classList.add("hidden");
    document.getElementById("field-image").value = "";
    document.getElementById("field-image").disabled = false;

    var deleteBtn = document.getElementById("delete-property-btn");

    if (idOrNull) {
      var feature = properties.find(function (f) { return f.properties.id === idOrNull; });
      if (!feature) return;

      document.getElementById("property-modal-title").textContent = "Edit Property";
      document.getElementById("field-title").value = feature.properties.title;
      document.getElementById("field-price").value = feature.properties.price;
      document.getElementById("field-size").value = feature.properties.size;
      setFieldValue("field-description", feature.properties.description || "");
      setSegmentedValue("field-type", feature.properties.type);
      setSegmentedValue("field-status", feature.properties.status);

      pendingGeometry = JSON.parse(JSON.stringify(feature.geometry));
      pendingImages = getImages(feature.properties).slice(0, MAX_IMAGES).filter(function (src) {
        return src !== PLACEHOLDER_IMAGE;
      });

      deleteBtn.classList.remove("hidden");
    } else {
      document.getElementById("property-modal-title").textContent = "Add Property";
      document.getElementById("field-title").value = "";
      document.getElementById("field-price").value = "";
      document.getElementById("field-size").value = "";
      setFieldValue("field-description", "");
      setSegmentedValue("field-type", "Land");
      setSegmentedValue("field-status", "Available");
      deleteBtn.classList.add("hidden");
    }

    renderImagePreviewGrid();
    updateGeometryStatus();
    openModal("property-modal");
  }

  // Computes the geodesic area (m²) of a drawn/edited parcel polygon,
  // using the area helper bundled with Leaflet.draw.
  function computePolygonArea(geometry) {
    try {
      if (!geometry || geometry.type !== "Polygon") return null;
      var ring = geometry.coordinates[0];
      var latlngs = ring.map(function (c) { return L.latLng(c[1], c[0]); });
      if (window.L && L.GeometryUtil && L.GeometryUtil.geodesicArea) {
        return L.GeometryUtil.geodesicArea(latlngs);
      }
    } catch (e) { /* ignore malformed geometry */ }
    return null;
  }

  function formatArea(squareMeters) {
    if (squareMeters >= 10000) {
      return (squareMeters / 10000).toFixed(2) + " ha (" + Math.round(squareMeters).toLocaleString() + " m²)";
    }
    return Math.round(squareMeters).toLocaleString() + " m²";
  }

  function updateGeometryStatus() {
    var el = document.getElementById("geometry-status");
    if (pendingGeometry) {
      var text = "Location set ✓";
      var area = computePolygonArea(pendingGeometry);
      if (area != null) {
        text += " — Area: " + formatArea(area);
      }
      el.textContent = text;
      el.classList.add("is-set");
    } else {
      el.textContent = "No location set yet";
      el.classList.remove("is-set");
    }
  }

  // ------------------------------------------------------------------
  // DRAW-ON-MAP GEOMETRY CAPTURE (Leaflet.draw)
  // ------------------------------------------------------------------
  function startDrawing() {
    var type = getSegmentedValue("field-type");

    // Hide the modal so the admin can interact with the map underneath.
    closeModal("property-modal");
    tempPreviewLayer.clearLayers();

    var drawBtn = document.getElementById("draw-geometry-btn");
    drawBtn.classList.add("is-drawing");

    // On some touch devices a pinch/zoom gesture can be misread as a tap,
    // which would drop an unwanted vertex while the admin is just zooming
    // in for precision. Disabling the tap handler while drawing prevents
    // that; it's re-enabled the moment drawing ends. Zooming itself
    // (scroll wheel, pinch, +/- buttons) is never touched otherwise, so it
    // keeps working normally — the admin can zoom in first, then click to
    // place each corner point.
    if (map.tap) map.tap.disable();

    if (type === "Land") {
      activeDrawHandler = new L.Draw.Polygon(map, {
        allowIntersection: false,
        showArea: true,   // live area readout (m² / ha) while tracing the parcel
        metric: true,
        shapeOptions: { color: "#10B981", weight: 2 }
      });
    } else {
      activeDrawHandler = new L.Draw.Marker(map, {});
    }
    activeDrawHandler.enable();
  }

  function cancelDrawing() {
    if (activeDrawHandler) {
      activeDrawHandler.disable();
      activeDrawHandler = null;
    }
    if (map.tap) map.tap.enable();
    document.getElementById("draw-geometry-btn").classList.remove("is-drawing");
    openModal("property-modal");
  }

  function onDrawCreated(e) {
    if (!activeDrawHandler) return; // ignore stray events

    var layer = e.layer;
    pendingGeometry = layer.toGeoJSON().geometry;

    tempPreviewLayer.clearLayers();
    tempPreviewLayer.addLayer(layer);

    activeDrawHandler.disable();
    activeDrawHandler = null;
    if (map.tap) map.tap.enable();
    document.getElementById("draw-geometry-btn").classList.remove("is-drawing");

    openModal("property-modal");
    updateGeometryStatus();
  }

  // ------------------------------------------------------------------
  // SAVE / DELETE PROPERTY
  // ------------------------------------------------------------------
  function generateNextId() {
    var maxNum = 0;
    properties.forEach(function (f) {
      var match = /^PROP-(\d+)$/.exec(f.properties.id);
      if (match) {
        var num = parseInt(match[1], 10);
        if (num > maxNum) maxNum = num;
      }
    });
    var next = maxNum + 1;
    var padded = next < 10 ? "00" + next : (next < 100 ? "0" + next : String(next));
    return "PROP-" + padded;
  }

  function saveProperty() {
    var title = document.getElementById("field-title").value.trim();
    var price = document.getElementById("field-price").value.trim();
    var size = document.getElementById("field-size").value.trim();
    var description = getFieldValue("field-description").trim();
    var type = getSegmentedValue("field-type");
    var status = getSegmentedValue("field-status");
    var errorEl = document.getElementById("property-form-error");

    if (!title || !price || !size) {
      errorEl.textContent = "Please fill in title, price, and size.";
      errorEl.classList.remove("hidden");
      return;
    }
    if (!pendingGeometry) {
      errorEl.textContent = "Please set a location using \"Draw on Map.\"";
      errorEl.classList.remove("hidden");
      return;
    }
    errorEl.classList.add("hidden");

    var wasAdding = !editingPropertyId;
    var images = pendingImages.slice(0, MAX_IMAGES);
    var primaryImage = images[0] || PLACEHOLDER_IMAGE;

    if (editingPropertyId) {
      var idx = properties.findIndex(function (f) { return f.properties.id === editingPropertyId; });
      if (idx === -1) return;
      var existing = properties[idx];
      properties[idx] = {
        type: "Feature",
        properties: {
          id: existing.properties.id,
          title: title,
          price: price,
          size: size,
          description: description,
          status: status,
          type: type,
          imageUrl: primaryImage,
          images: images
        },
        geometry: pendingGeometry
      };
    } else {
      properties.push({
        type: "Feature",
        properties: {
          id: generateNextId(),
          title: title,
          price: price,
          size: size,
          description: description,
          status: status,
          type: type,
          imageUrl: primaryImage,
          images: images
        },
        geometry: pendingGeometry
      });
    }

    saveProperties();
    tempPreviewLayer.clearLayers();
    closeModal("property-modal");
    renderAll();

    if (wasAdding) {
      fitMapToAllProperties(true); // zoom out so the newly-added property is visible too
    }
  }

  function confirmDelete(id) {
    var feature = properties.find(function (f) { return f.properties.id === id; });
    var name = feature ? feature.properties.title : "this property";
    openConfirm('Delete "' + name + '"? This cannot be undone.', function () {
      removeProperty(id);
    });
  }

  function removeProperty(id) {
    properties = properties.filter(function (f) { return f.properties.id !== id; });
    saveProperties();
    closeModal("property-modal");
    renderAll();
  }

  // ==================================================================
  // GENERIC MODAL HELPERS
  // ==================================================================
  function openModal(id) {
    document.getElementById(id).classList.remove("hidden");
  }

  function closeModal(id) {
    document.getElementById(id).classList.add("hidden");
  }

  function bindModalGenerics() {
    document.querySelectorAll("[data-close-modal]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        closeModal(btn.dataset.closeModal);
      });
    });

    document.querySelectorAll(".modal-overlay").forEach(function (overlay) {
      overlay.addEventListener("click", function (e) {
        if (e.target === overlay) {
          overlay.classList.add("hidden");
        }
      });
    });

    document.getElementById("confirm-cancel-btn").addEventListener("click", function () {
      confirmCallback = null;
      closeModal("confirm-modal");
    });

    document.getElementById("confirm-ok-btn").addEventListener("click", function () {
      var cb = confirmCallback;
      confirmCallback = null;
      closeModal("confirm-modal");
      if (cb) cb();
    });
  }

  function openConfirm(message, onConfirm) {
    document.getElementById("confirm-message").textContent = message;
    confirmCallback = onConfirm;
    openModal("confirm-modal");
  }

})();
