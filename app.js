import { geocode, route, forecast, StageError } from "./api.js";
import {
  samplePoints, alongRoute, indexForecast, simulateDepartures, verdict,
  fmtTime, fmtWhen, fmtKm, localInputValue, parseLocalInput, CLASSES,
} from "./logic.js";
import { loadRadar, radarAt, radarTileUrl, HORIZON_MIN } from "./radar.js";

const $ = (id) => document.getElementById(id);
const els = {
  form: $("form"), origem: $("origem"), destino: $("destino"), saida: $("saida"), agora: $("agora"), go: $("go"),
  locate: $("locate"), swap: $("swap"), theme: $("theme"),
  status: $("status"), error: $("error"), result: $("result"),
  verdict: $("verdict"), vTime: $("verdict-time"), vTitle: $("verdict-title"), vDetail: $("verdict-detail"), vAlt: $("verdict-alt"), vRoute: $("verdict-route"),
  pastNote: $("past-note"), bars: $("bars"), rows: $("rows"), radar: $("radar"), updated: $("updated"),
  fromName: $("from-name"), toName: $("to-name"), radarLegend: $("radar-legend"), sourceNote: $("source-note"),
};

const DATA_TTL = 10 * 60000;
const SOURCE_LABEL = { observado: "Radar (registrado)", radar: "Radar", modelo: "Previsão" };

let map;
let routeLayer;
let kmLayer;
let radarLayer;
let state = null;
let data = null;
let useNow = true;

function save(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}
function load(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

const savedO = load("origem");
const savedD = load("destino");
if (savedO) els.origem.value = savedO;
if (savedD) els.destino.value = savedD;
els.saida.value = localInputValue(Date.now());

els.theme.addEventListener("click", () => {
  const root = document.documentElement;
  const current = root.dataset.theme ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = current === "dark" ? "light" : "dark";
  root.dataset.theme = next;
  save("tema", next);
});

els.swap.addEventListener("click", () => {
  [els.origem.value, els.destino.value] = [els.destino.value, els.origem.value];
});

els.agora.addEventListener("click", () => {
  useNow = true;
  els.saida.value = localInputValue(Date.now());
  els.agora.classList.add("selected");
  run();
});

els.saida.addEventListener("change", () => {
  if (!els.saida.value) return;
  useNow = false;
  els.agora.classList.remove("selected");
  run();
});

els.locate.addEventListener("click", () => {
  if (!("geolocation" in navigator) || !window.isSecureContext) {
    showError("localização", "Seu navegador só libera a localização em páginas https (ou localhost). Abra o app pelo endereço publicado ou cole as coordenadas.");
    return;
  }
  setStatus("Pegando sua localização…");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      els.origem.value = `${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}`;
      setStatus("");
      run();
    },
    (err) => {
      setStatus("");
      showError("localização", err.code === 1 ? "Permissão de localização negada." : "Não consegui obter sua localização.");
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
  );
});

els.form.addEventListener("submit", (e) => {
  e.preventDefault();
  run();
});

function setStatus(text) {
  els.status.hidden = !text;
  els.status.textContent = text;
}

function showError(stage, message) {
  els.error.hidden = false;
  els.error.innerHTML = "";
  const s = document.createElement("strong");
  s.textContent = `Falhou na etapa: ${stage}`;
  els.error.append(s, document.createTextNode(message));
}

function departureBase() {
  if (useNow) return Date.now();
  const t = parseLocalInput(els.saida.value);
  if (Number.isNaN(t)) throw new StageError("horário", "Horário de saída inválido.");
  return t;
}

async function loadData() {
  const key = `${els.origem.value.trim()}|${els.destino.value.trim()}`;
  if (data && data.key === key && Date.now() - data.fetchedAt < DATA_TTL) return data;

  setStatus("Procurando endereços…");
  const from = await geocode(els.origem.value, "origem");
  const to = await geocode(els.destino.value, "destino");
  save("origem", els.origem.value);
  save("destino", els.destino.value);

  setStatus("Traçando a rota…");
  const r = await route(from, to);

  setStatus("Buscando a previsão e o radar…");
  const { points } = samplePoints(r.coords, 10);
  const [raw, radar] = await Promise.all([
    forecast(points),
    loadRadar(r.coords).catch((e) => {
      console.warn("radar indisponível", e);
      return null;
    }),
  ]);
  const forecasts = raw.map(indexForecast);

  const sameRoute = data && data.key === key;
  data = { key, from, to, route: r, points, forecasts, radar, fetchedAt: Date.now(), fitted: sameRoute && data.fitted };
  const ht = forecasts[0].hourlyT;
  els.saida.min = localInputValue(ht[0]);
  els.saida.max = localInputValue(ht[ht.length - 1] - 3 * 3600000 - r.duration * 1000);
  return data;
}

async function run() {
  els.error.hidden = true;
  els.go.disabled = true;
  try {
    const d = await loadData();
    const base = departureBase();
    const ht = d.forecasts[0].hourlyT;
    const lastStart = ht[ht.length - 1] - 3 * 3600000 - d.route.duration * 1000;
    if (base < ht[0] || base > lastStart) {
      throw new StageError("horário", `Escolha uma saída entre ${fmtWhen(ht[0])} e ${fmtWhen(lastStart)}. Fora disso não há previsão.`);
    }

    let sim;
    try {
      sim = simulateDepartures({
        points: d.points, forecasts: d.forecasts, distance: d.route.distance, duration: d.route.duration, now: base,
        radarAt: d.radar ? (lat, lon, epoch) => radarAt(d.radar, lat, lon, epoch) : null,
      });
    } catch (e) {
      throw new StageError("previsão", `Não deu pra cruzar a rota com a previsão (${e.message}).`);
    }

    state = { sim, selected: sim.trips[0], base, isLive: useNow };
    setStatus("");
    els.result.hidden = false;
    render();
  } catch (e) {
    setStatus("");
    showError(e.stage ?? "desconhecida", e.message);
    console.error(e);
  } finally {
    els.go.disabled = false;
  }
}

function shortName(name) {
  return name.split(", ").filter((p) => !/^(São Paulo|Região Sudeste|Brasil|\d{5}-\d{3})$/.test(p)).slice(0, 3).join(", ");
}

function rankOf(cls) {
  return CLASSES[cls].rank;
}

function segmentClasses(legs) {
  const out = [];
  for (let i = 0; i < legs.length - 1; i++) {
    out.push(rankOf(legs[i].cls) >= rankOf(legs[i + 1].cls) ? legs[i].cls : legs[i + 1].cls);
  }
  return out;
}

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

function altSuggestion(sim, selected) {
  if (selected.worst === "seco") return "";
  const later = sim.trips.filter((t) => t.departure > selected.departure);
  const dry = later.find((t) => t.worst === "seco");
  if (dry) return `Saindo às ${fmtTime(dry.departure)}, não pega chuva.`;
  if (selected.worst === "forte") {
    const lighter = later.find((t) => t.worst === "chuva");
    if (lighter) return `Saindo às ${fmtTime(lighter.departure)}, a chuva é mais fraca.`;
  }
  return "Nas próximas 3 horas não abre uma janela sem chuva.";
}

function pastNote(trip) {
  if (trip.departure >= Date.now() - 5 * 60000) return "";
  if (trip.legs.every((l) => l.src === "observado")) return "Esse horário já passou. A resposta vem do que o radar registrou na hora.";
  return "Esse horário já passou e o radar só guarda as últimas 2 horas. A resposta vem da previsão daquele momento, não de medição.";
}

function render() {
  const { sim, selected, isLive } = state;
  const { route: r, from, to, radar } = data;
  const v = verdict(selected);

  els.verdict.className = `verdict ${v.cls}`;
  els.vTitle.textContent = v.title;
  els.vDetail.textContent = v.detail;
  const alt = altSuggestion(sim, selected);
  els.vAlt.hidden = !alt;
  els.vAlt.textContent = alt;
  els.vTime.textContent = isLive && selected === sim.trips[0]
    ? `Saindo agora, chega às ${fmtTime(selected.departure + r.duration * 1000)}`
    : `Saindo ${fmtWhen(selected.departure)}, chega às ${fmtTime(selected.departure + r.duration * 1000)}`;
  const note = pastNote(selected);
  els.pastNote.hidden = !note;
  els.pastNote.textContent = note;

  els.bars.innerHTML = "";
  sim.trips.forEach((t, i) => {
    const b = el("button", `bar ${t.worst}${t === selected ? " selected" : ""}`);
    b.type = "button";
    b.setAttribute("role", "listitem");
    b.setAttribute("aria-pressed", String(t === selected));
    b.setAttribute("aria-label", `Sair às ${fmtTime(t.departure)}: ${verdict(t).title}`);
    const track = el("span", "track");
    track.append(el("span", "fill"));
    b.append(track, el("span", "t", i % 2 === 0 ? fmtTime(t.departure) : ""));
    b.addEventListener("click", () => {
      state.selected = t;
      render();
    });
    els.bars.append(b);
  });

  els.fromName.textContent = shortName(from.name);
  els.toName.textContent = shortName(to.name);
  els.vRoute.textContent = `${fmtKm(r.distance / 1000)} km, cerca de ${Math.round(r.duration / 60)} min de carro.`;
  els.sourceNote.textContent = radar
    ? `Até ${HORIZON_MIN} min depois da última imagem do radar (${fmtTime(radar.latest.time)}), a resposta vem do radar: onde está chovendo e para onde a chuva está indo. Depois disso, vem da previsão da Open-Meteo, que é regional.`
    : "O radar não carregou agora, então a resposta vem só da previsão da Open-Meteo, que é regional.";

  els.rows.innerHTML = "";
  for (const l of selected.legs) {
    const tr = el("tr", l.cls);
    tr.innerHTML = `<td><i class="tick ${l.cls}"></i>${fmtKm(l.km)}</td><td>${fmtTime(l.epoch)}</td><td>${Math.round(l.prob)}%</td><td>${l.mm.toFixed(1)}</td><td class="sky"></td>`;
    const sky = tr.querySelector(".sky");
    sky.append(document.createTextNode(SOURCE_LABEL[l.src]), el("b", null, CLASSES[l.cls].label));
    els.rows.append(tr);
  }

  const mid = r.coords[Math.floor(r.coords.length / 2)];
  els.radar.href = `https://www.rainviewer.com/map.html?loc=${mid[1].toFixed(4)},${mid[0].toFixed(4)},10&oFa=0&oC=1&oU=0&oCS=1&oF=0&oAP=1&c=3&o=83&lm=1&layer=radar&sm=1&sn=1`;
  els.updated.textContent = fmtTime(data.fetchedAt);

  const showRadar = radar && selected.legs.some((l) => l.src !== "modelo");
  els.radarLegend.hidden = !showRadar;
  if (showRadar) els.radarLegend.textContent = `Radar das ${fmtTime(radar.latest.time)}`;

  drawMap(selected, showRadar);
}

function divIcon(className, html) {
  return L.divIcon({ className, html: `<span>${html}</span>`, iconSize: null });
}

function legPopup(l) {
  return `<strong>km ${fmtKm(l.km)}, às ${fmtTime(l.epoch)}</strong><br><span class="pop-cls ${l.cls}">${CLASSES[l.cls].label}</span><br><small>${SOURCE_LABEL[l.src]}</small>`;
}

function nearestLeg(legs, latlng) {
  let best = legs[0];
  let bestD = Infinity;
  for (const l of legs) {
    const d = map.distance(latlng, [l.lat, l.lon]);
    if (d < bestD) { bestD = d; best = l; }
  }
  return best;
}

function drawMap(trip, showRadar) {
  if (!window.L) return;
  if (!map) {
    map = L.map("map", { zoomControl: true, attributionControl: true });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      className: "base-tiles",
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    map.on("zoomend", drawKm);
  }

  const url = showRadar ? radarTileUrl(data.radar) : null;
  if (radarLayer && radarLayer.options.radarUrl !== url) {
    radarLayer.remove();
    radarLayer = null;
  }
  if (url && !radarLayer) {
    radarLayer = L.tileLayer(url, {
      radarUrl: url,
      maxNativeZoom: 7,
      maxZoom: 19,
      opacity: 0.6,
      className: "radar-tiles",
      attribution: '<a href="https://www.rainviewer.com/">RainViewer</a>',
    }).addTo(map);
  }

  if (routeLayer) routeLayer.remove();
  routeLayer = L.layerGroup().addTo(map);

  const { coords } = data.route;
  const latlngs = coords.map(([lon, lat]) => [lat, lon]);
  const line = { lineCap: "round", lineJoin: "round" };
  L.polyline(latlngs, { ...line, className: "route-casing", weight: 14, opacity: 1, interactive: false }).addTo(routeLayer);

  const legs = trip.legs;
  const classes = segmentClasses(legs);
  for (let i = 0; i < legs.length - 1; i++) {
    const a = legs[i];
    const b = legs[i + 1];
    const seg = [[a.lat, a.lon], ...latlngs.slice(a.pathIndex, b.pathIndex), [b.lat, b.lon]];
    L.polyline(seg, { ...line, className: `seg ${classes[i]}`, weight: 8, opacity: 1, interactive: false }).addTo(routeLayer);
  }
  L.polyline(latlngs, { ...line, className: "route-hit", weight: 28, opacity: 1 })
    .on("click", (e) => {
      L.popup({ maxWidth: 240 }).setLatLng(e.latlng).setContent(legPopup(nearestLeg(legs, e.latlng))).openOn(map);
    })
    .addTo(routeLayer);

  L.marker([data.from.lat, data.from.lon], { icon: divIcon("pin", "<b>A</b>"), title: "Origem", zIndexOffset: 1000 }).bindPopup(`<strong>Saída</strong><br>${shortName(data.from.name)}`).addTo(routeLayer);
  L.marker([data.to.lat, data.to.lon], { icon: divIcon("pin", "<b>B</b>"), title: "Destino", zIndexOffset: 1000 }).bindPopup(`<strong>Chegada</strong><br>${shortName(data.to.name)}`).addTo(routeLayer);

  if (!data.fitted) {
    map.fitBounds(L.latLngBounds(latlngs), { padding: [36, 36] });
    data.fitted = true;
  }
  drawKm();
  setTimeout(() => map.invalidateSize(), 0);
}

function drawKm() {
  if (!data) return;
  if (kmLayer) kmLayer.remove();
  kmLayer = L.layerGroup().addTo(map);
  const z = map.getZoom();
  const every = z >= 14 ? 1 : z >= 12 ? 2 : z >= 10 ? 5 : 10;
  const totalKm = data.route.distance / 1000;
  const kms = [];
  for (let k = every; k < totalKm - 0.4; k += every) kms.push(k);
  const pts = alongRoute(data.route.coords, kms.map((k) => k / totalKm));
  const ends = [data.from, data.to].map((p) => map.latLngToLayerPoint([p.lat, p.lon]));
  let last = null;
  pts.forEach((p, i) => {
    const px = map.latLngToLayerPoint([p.lat, p.lon]);
    if (last && px.distanceTo(last) < 56) return;
    if (ends.some((e) => px.distanceTo(e) < 30)) return;
    last = px;
    L.marker([p.lat, p.lon], { icon: divIcon("km-tag", `${kms[i]} km`), interactive: false, keyboard: false, zIndexOffset: 500 }).addTo(kmLayer);
  });
}

run();
