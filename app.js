/**
 * app.js
 * -----------------------------------------------------------------------
 * Leaflet initialization, GeoJSON binding, sidebar synchronization,
 * and filter interactivity for the Meridian Estates dashboard.
 * -----------------------------------------------------------------------
 */

(function () {
  "use strict";

  // ------------------------------------------------------------------
  // STATE
  // ------------------------------------------------------------------
  var map;
  var geoJsonLayer;
  var currentFilter = "All";
  var layersById = {};   // id -> Leaflet layer, for sidebar <-> map sync

  var STATUS_COLORS = {
    Available: "#10B981",
    Sold: "#F4735B"
  };

  // ------------------------------------------------------------------
  // INIT
  // ------------------------------------------------------------------
  document.addEventListener("DOMContentLoaded", init);

  function init() {
    initMap();
    renderGeoJson();
    renderListings();
    bindFilterButtons();
    bindResizeHandling();
  }

  function initMap() {
    // Center roughly on the mock dataset's centroid.
    map = L.map("map", {
      zoomControl: true,
      scrollWheelZoom: true
    }).setView([40.0200, -105.2775], 15);

    // Crisp, neutral CartoDB Positron basemap (free, no API key required).
    L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
      {
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: "abcd",
        maxZoom: 20
      }
    ).addTo(map);

    // Mobile browsers frequently finish resizing the layout (address bar
    // collapsing, orientation settling, media queries applying) slightly
    // AFTER Leaflet has already measured the #map container. That mismatch
    // is what causes a blank/white map on phones. Forcing a couple of
    // delayed invalidateSize() calls makes Leaflet re-measure and redraw
    // its tiles once the real, final layout is in place.
    setTimeout(function () { map.invalidateSize(); }, 200);
    setTimeout(function () { map.invalidateSize(); }, 600);
  }

  // ------------------------------------------------------------------
  // RESPONSIVE MAP RESIZING
  // ------------------------------------------------------------------
  function bindResizeHandling() {
    window.addEventListener("resize", function () {
      map.invalidateSize();
    });

    // orientationchange fires on phones/tablets before resize does, and
    // the viewport dimensions aren't reliable until slightly after.
    window.addEventListener("orientationchange", function () {
      setTimeout(function () { map.invalidateSize(); }, 300);
    });
  }

  // ------------------------------------------------------------------
  // GEOJSON RENDERING
  // ------------------------------------------------------------------
  function renderGeoJson() {
    if (geoJsonLayer) {
      map.removeLayer(geoJsonLayer);
    }
    layersById = {};

    geoJsonLayer = L.geoJSON(realEstateData, {
      filter: featureMatchesFilter,
      style: styleFeature,
      pointToLayer: pointToLayer,
      onEachFeature: onEachFeature
    }).addTo(map);
  }

  function featureMatchesFilter(feature) {
    if (currentFilter === "All") return true;
    return feature.properties.status === currentFilter;
  }

  // Styling for polygon features (land parcels)
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

  // Styling for point features (residential listings) as circle markers
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

    layer.bindPopup(buildPopupHtml(props));

    layer.on({
      mouseover: function (e) {
        highlightLayer(e.target, feature);
      },
      mouseout: function (e) {
        resetLayerStyle(e.target, feature);
      },
      click: function (e) {
        focusFeature(props.id, false);
      }
    });
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

  function buildPopupHtml(props) {
    return (
      '<div class="popup-card">' +
        '<img class="card-image" src="' + props.imageUrl + '" alt="' + escapeHtml(props.title) + '" />' +
        '<div class="card-body">' +
          '<div class="card-top-row">' +
            '<div class="card-title">' + escapeHtml(props.title) + "</div>" +
            '<span class="status-badge ' + props.status + '">' + props.status + "</span>" +
          "</div>" +
          '<div class="card-price">' + props.price + "</div>" +
          '<div class="card-meta">' +
            '<span class="type-pill">' + props.type + '</span>' +
            '<span class="dot"></span>' +
            '<span>' + props.size + '</span>' +
          '</div>' +
        "</div>" +
      "</div>"
    );
  }

  function escapeHtml(str) {
    var div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // ------------------------------------------------------------------
  // SIDEBAR LISTINGS
  // ------------------------------------------------------------------
  function renderListings() {
    var container = document.getElementById("listings-container");
    container.innerHTML = "";

    var visibleFeatures = realEstateData.features.filter(featureMatchesFilter);

    document.getElementById("listings-count").textContent =
      visibleFeatures.length + (visibleFeatures.length === 1 ? " property" : " properties");

    visibleFeatures.forEach(function (feature) {
      var props = feature.properties;
      var card = document.createElement("div");
      card.className = "property-card";
      card.dataset.id = props.id;

      card.innerHTML =
        '<img class="card-image" src="' + props.imageUrl + '" alt="' + escapeHtml(props.title) + '" />' +
        '<div class="card-body">' +
          '<div class="card-top-row">' +
            '<div class="card-title">' + escapeHtml(props.title) + "</div>" +
            '<span class="status-badge ' + props.status + '">' + props.status + "</span>" +
          "</div>" +
          '<div class="card-price">' + props.price + "</div>" +
          '<div class="card-meta">' +
            '<span class="type-pill">' + props.type + '</span>' +
            '<span class="dot"></span>' +
            '<span>' + props.size + '</span>' +
          '</div>' +
        "</div>";

      card.addEventListener("click", function () {
        focusFeature(props.id, true);
      });

      container.appendChild(card);
    });
  }

  // ------------------------------------------------------------------
  // CROSS-LINKING: SIDEBAR <-> MAP
  // ------------------------------------------------------------------
  function focusFeature(id, fromSidebar) {
    var layer = layersById[id];
    if (!layer) return;

    // Pan/zoom to the feature.
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
    var buttons = document.querySelectorAll(".filter-btn");
    buttons.forEach(function (btn) {
      btn.addEventListener("click", function () {
        buttons.forEach(function (b) { b.classList.remove("active"); });
        btn.classList.add("active");
        currentFilter = btn.dataset.filter;
        renderGeoJson();
        renderListings();
      });
    });
  }

})();
