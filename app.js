import { geocode, searchPlaces, VEHICLES, route, forecast, StageError } from "./api.js";
import {
  samplePoints, alongRoute, indexForecast, departureWindow, simulateDepartures, comparisonDepartures, parseCoords, verdict,
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
let busy = false;
let busyFocus = null;
let renderedSim = null;
let vehicle = "car";
const confirmed = { origem: null, destino: null };
let placeMap;
let placeMarker;

function renderConfirmed() {
  const items = Object.entries(confirmed).filter(([id, value]) => value && value.query === els[id].value.trim());
  $("confirmed-places").hidden = !items.length;
  $("confirmed-places").replaceChildren(...items.map(([id, value]) => {
    const item = el("div");
    item.append(el("strong", null, `✓ ${id === "origem" ? "Origem confirmada" : "Destino confirmado"}`), el("p", null, value.place.name));
    return item;
  }));
}

function previewPlace(place) {
  $("place-kind").textContent = place.kind ?? "Local encontrado";
  $("place-name").textContent = place.name.split(",")[0];
  $("place-address").textContent = place.name;
  $("place-external").href = `https://www.google.com/maps/search/?api=1&query=${place.lat},${place.lon}`;
  if (!window.L) {
    $("place-map").className = "map-unavailable";
    $("place-map").textContent = `Mapa indisponível · ${place.lat.toFixed(5)}, ${place.lon.toFixed(5)}`;
    return;
  }
  if (!placeMap) {
    placeMap = L.map("place-map", { scrollWheelZoom: false });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      className: "base-tiles", maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).on("tileerror", () => { $("place-map-notice").hidden = false; }).addTo(placeMap);
  }
  placeMap.invalidateSize();
  placeMap.setView([place.lat, place.lon], 15, { animate: false });
  if (placeMarker) placeMarker.remove();
  placeMarker = L.circleMarker([place.lat, place.lon], { radius: 10, color: "#ffffff", weight: 3, fillColor: "#bc422b", fillOpacity: 1 }).addTo(placeMap);
}

async function resolvePlace(id, force = false) {
  const query = els[id].value.trim();
  if (!force && confirmed[id]?.query === query) return confirmed[id].place;
  // Coordinates already identify an exact point; the preview remains available on demand.
  if (!force && parseCoords(query)) return geocode(query, id);
  setStatus(`Procurando ${id === "origem" ? "a origem" : "o destino"}…`);
  const places = await searchPlaces(query, id);
  setStatus("");
  const dialog = $("place-dialog");
  $("place-dialog-title").textContent = id === "origem" ? "É daqui que você vai sair?" : "É para cá que você vai?";
  $("place-confirm").textContent = id === "origem" ? "Confirmar origem" : "Confirmar destino";
  let selected = places[0];
  $("place-options").replaceChildren(...places.map((place, i) => {
    const label = el("label", "place-choice");
    const radio = el("input");
    radio.type = "radio";
    radio.name = "place-option";
    radio.value = String(i);
    radio.checked = i === 0;
    radio.addEventListener("change", () => { selected = place; previewPlace(place); });
    label.append(radio, el("span", null, place.name));
    return label;
  }));
  const choice = await new Promise(resolve => {
    let accepted = false;
    $("place-confirm").onclick = () => { accepted = true; dialog.close(); };
    $("place-close").onclick = $("place-cancel").onclick = () => dialog.close();
    dialog.addEventListener("close", () => resolve(accepted ? selected : null), { once: true });
    dialog.showModal();
    previewPlace(selected);
    $("place-options").querySelector("input").focus({ preventScroll: true });
  });
  if (!choice) throw new StageError("cancelado", id);
  confirmed[id] = { query, place: choice };
  renderConfirmed();
  return choice;
}

for (const id of ["origem", "destino"]) {
  $("check-" + id).addEventListener("click", async () => {
    if (busy) return;
    edited();
    $("initial").hidden = true;
    setBusy(true);
    let cancelled = false;
    try { await resolvePlace(id, true); }
    catch (e) {
      cancelled = e.stage === "cancelado";
      if (!cancelled) showError(e.stage ?? "endereço", e.message);
    } finally {
      setStatus("");
      setBusy(false);
      if (els.error.hidden) $("initial").hidden = false;
      if (cancelled) els[id].focus();
    }
  });
}
for (const radio of document.querySelectorAll('[name="vehicle"]')) {
  radio.addEventListener("change", () => {
    vehicle = radio.value;
    $("vehicle-note").textContent = VEHICLES[vehicle].note;
    save("vehicle", vehicle);
    els.saida.removeAttribute("min");
    els.saida.removeAttribute("max");
    edited();
  });
}


function weatherIcon(cls) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#icon-${cls}`);
  svg.append(use);
  return svg;
}

function setBusy(value) {
  if (value) busyFocus = document.activeElement;
  busy = value;
  els.form.setAttribute("aria-busy", String(value));
  for (const control of els.form.elements) control.disabled = value;
  els.go.querySelector("span").textContent = value ? "Consultando a rota…" : "Ver chuva no caminho";
  if (!value && (document.activeElement === document.body || document.activeElement === busyFocus)) {
    const target = els.form.hidden ? $("trip-summary") : busyFocus?.getClientRects().length ? busyFocus : els.go;
    target?.focus({ preventScroll: true });
  }
}

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
const savedVehicle = load("vehicle");
if (savedVehicle && Object.hasOwn(VEHICLES, savedVehicle)) {
  vehicle = savedVehicle;
  document.querySelector(`[name="vehicle"][value="${vehicle}"]`).checked = true;
  $("vehicle-note").textContent = VEHICLES[vehicle].note;
}

function currentTheme() {
  return document.documentElement.dataset.theme ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
}
function syncTheme() {
  const dark = currentTheme() === "dark";
  els.theme.setAttribute("aria-label", dark ? "Ativar tema claro" : "Ativar tema escuro");
  els.theme.title = els.theme.getAttribute("aria-label");
  document.querySelector('meta[name="theme-color"]').content = dark ? "#101519" : "#f5f5ef";
}
syncTheme();
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", syncTheme);
els.theme.addEventListener("click", () => {
  const root = document.documentElement;
  const current = currentTheme();
  const next = current === "dark" ? "light" : "dark";
  root.dataset.theme = next;
  save("tema", next);
  syncTheme();
});

// The form stays available on desktop; successful mobile queries reveal the answer first.
const desktopLayout = matchMedia("(min-width: 1024px)");
let plannerCollapsed = false;
function syncPlanner() {
  const summary = $("trip-summary");
  const hasResult = !els.result.hidden;
  const collapse = hasResult && plannerCollapsed && !desktopLayout.matches;
  const focusInForm = els.form.contains(document.activeElement);
  const focusOnSummary = document.activeElement === summary;
  summary.hidden = !hasResult || desktopLayout.matches;
  summary.setAttribute("aria-expanded", String(!collapse));
  summary.querySelector(".summary-action").textContent = collapse ? "Editar" : "Fechar";
  syncSummaryLabel();
  els.form.hidden = collapse;
  document.body.classList.toggle("has-result", hasResult);
  if (collapse && focusInForm) summary.focus({ preventScroll: true });
  if (summary.hidden && focusOnSummary) els.go.focus({ preventScroll: true });
}
function syncSummaryLabel() {
  const summary = $("trip-summary");
  if (summary.dataset.trip) summary.setAttribute("aria-label", `${summary.dataset.trip}. ${summary.getAttribute("aria-expanded") === "false" ? "Editar viagem" : "Fechar edição"}`);
}
$("trip-summary").addEventListener("click", () => {
  plannerCollapsed = !plannerCollapsed;
  syncPlanner();
});
desktopLayout.addEventListener("change", syncPlanner);

function edited() {
  els.result.hidden = true;
  plannerCollapsed = false;
  syncPlanner();
  els.error.hidden = true;
  $("result-link").hidden = true;
  $("initial").hidden = false;
  for (const input of [els.origem, els.destino, els.saida]) input.removeAttribute("aria-invalid");
}
for (const input of [els.origem, els.destino]) input.addEventListener("input", () => {
  confirmed[input.id] = null;
  renderConfirmed();
  edited();
  els.saida.removeAttribute("min");
  els.saida.removeAttribute("max");
});
els.swap.addEventListener("click", () => {
  [els.origem.value, els.destino.value] = [els.destino.value, els.origem.value];
  [confirmed.origem, confirmed.destino] = [confirmed.destino, confirmed.origem];
  renderConfirmed();
  edited();
  $("announcement").textContent = "Origem e destino invertidos. Consulte a previsão para a nova rota.";
});

els.agora.addEventListener("click", () => {
  useNow = true;
  els.saida.value = localInputValue(Date.now());
  els.agora.classList.add("selected");
  els.agora.setAttribute("aria-pressed", "true");
  edited();
});

els.saida.addEventListener("change", () => {
  useNow = false;
  els.agora.classList.remove("selected");
  els.agora.setAttribute("aria-pressed", "false");
  edited();
});

els.locate.addEventListener("click", () => {
  if (!("geolocation" in navigator) || !window.isSecureContext) {
    showError("localização", "Seu navegador só libera a localização em páginas https (ou localhost). Abra o app pelo endereço publicado ou cole as coordenadas.");
    return;
  }
  if (busy) return;
  edited();
  setBusy(true);
  $("initial").hidden = true;
  els.error.hidden = true;
  setStatus("Pegando sua localização…");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      els.origem.value = `${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}`;
      confirmed.origem = null;
      renderConfirmed();
      setStatus("");
      setBusy(false);
      edited();
      els.destino.focus();
      $("announcement").textContent = "Localização preenchida como origem. Confira o destino e consulte a previsão.";
    },
    (err) => {
      setBusy(false);
      setStatus("");
      showError("localização", err.code === 1 ? "Permissão de localização negada. Digite seu endereço no campo de origem ou permita o acesso nas configurações do navegador." : "Não foi possível obter sua localização. Digite o endereço de origem ou tente novamente.");
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
  $("initial").hidden = true;
  els.error.hidden = false;
  els.error.innerHTML = "";
  const s = document.createElement("strong");
  const titles = { endereço: "Vamos conferir os endereços?", rota: "Não foi possível traçar a rota", previsão: "A previsão está indisponível", horário: "Escolha outro horário de saída", localização: "Não foi possível usar sua localização" };
  s.textContent = titles[stage] ?? "Não foi possível concluir a consulta";
  els.error.append(s, document.createTextNode(message));
  $("result-link").hidden = false;
  $("result-link").href = "#error";
  $("result-link").textContent = "Revisar consulta ↓";
  if (!["endereço", "horário", "localização"].includes(stage)) {
    const retry = el("button", "text-action", "Tentar novamente →");
    retry.type = "button";
    retry.addEventListener("click", run);
    els.error.append(retry);
  }
}

function departureBase() {
  if (useNow) return Date.now();
  const t = parseLocalInput(els.saida.value);
  if (Number.isNaN(t)) throw new StageError("horário", "Horário de saída inválido.");
  return t;
}

async function loadData() {
  const from = await resolvePlace("origem");
  const to = await resolvePlace("destino");
  const key = `${from.lat},${from.lon}|${to.lat},${to.lon}|${vehicle}`;
  if (data && data.key === key && Date.now() - data.fetchedAt < DATA_TTL) return data;

  setStatus("Procurando endereços…");
  save("origem", els.origem.value);
  save("destino", els.destino.value);

  setStatus("Traçando a rota…");
  const r = await route(from, to, vehicle);

  setStatus("Buscando a previsão e o radar…");
  const { points } = samplePoints(r.coords, 10);
  const [raw, radar] = await Promise.all([
    forecast(points),
    loadRadar(r.coords).catch((e) => {
      console.warn("radar indisponível", e);
      return null;
    }),
  ]);
  let forecasts;
  try { forecasts = raw.map(indexForecast); }
  catch (e) { throw new StageError("previsão", e.message); }

  const sameRoute = data && data.key === key;
  data = { key, from, to, vehicle, route: r, points, forecasts, radar, fetchedAt: Date.now(), fitted: sameRoute && data.fitted };
  const window = departureWindow(forecasts, r.duration);
  els.saida.min = localInputValue(window.min);
  els.saida.max = localInputValue(window.max);
  return data;
}

async function run() {
  if (busy) return;
  for (const input of [els.origem, els.destino]) {
    if (!input.value.trim()) {
      showError("endereço", `Preencha ${input === els.origem ? "a origem" : "o destino"} para consultar a viagem.`);
      input.setAttribute("aria-invalid", "true");
      input.focus();
      return;
    }
  }
  setBusy(true);
  $("initial").hidden = true;
  $("result-link").hidden = true;
  els.error.hidden = true;
  els.result.hidden = true;
  syncPlanner();
  try {
    departureBase(); // Validate before starting network requests.
    const d = await loadData();
    const base = departureBase();
    const window = departureWindow(d.forecasts, d.route.duration);
    if (base < window.min || base > window.max) {
      throw new StageError("horário", `Escolha uma saída entre ${fmtWhen(window.min)} e ${fmtWhen(window.max)}. Fora disso não há previsão.`);
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

    sim = comparisonDepartures(sim);
    state = { sim, selected: sim.trips[0], base, isLive: useNow };
    setStatus("");
    els.result.hidden = false;
    render();
    $("result-link").hidden = false;
    plannerCollapsed = true;
    syncPlanner();
    if (!desktopLayout.matches) globalThis.scrollTo(0, 0);
  } catch (e) {
    if (e.stage === "cancelado") {
      $("initial").hidden = false;
      setStatus("");
      setBusy(false);
      els[e.message]?.focus();
      return;
    }
    if (e.stage === "previsão") data = null;
    setStatus("");
    showError(e.stage ?? "desconhecida", e.message);
    if (e.stage === "horário") els.saida.setAttribute("aria-invalid", "true");
    console.error(e);
  } finally {
    setBusy(false);
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
  if (dry) return `Saindo às ${fmtTime(dry.departure)}, a previsão não indica chuva.`;
  if (selected.worst === "forte") {
    const lighter = later.find((t) => t.worst === "chuva");
    if (lighter) return `Saindo às ${fmtTime(lighter.departure)}, a previsão indica chuva mais fraca.`;
  }
  return later.length ? "A previsão não indica uma janela sem chuva nos horários seguintes exibidos." : "Este é o último horário da comparação. Consulte uma nova saída para ver mais opções.";
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
  els.vTitle.textContent = { seco: "Sem chuva prevista", chuva: "Chuva no caminho", forte: "Chuva forte prevista" }[v.cls];
  $("result-link").href = "#verdict";
  $("result-link").textContent = `${els.vTitle.textContent} · Ver viagem ↓`;
  $("verdict-icon").replaceChildren(weatherIcon(v.cls));
  els.vDetail.textContent = v.detail;
  const alt = altSuggestion(sim, selected);
  els.vAlt.hidden = !alt;
  els.vAlt.textContent = alt;
  $("alternative").hidden = !alt;
  const better = sim.trips.find((t) => t.departure > selected.departure && rankOf(t.worst) < rankOf(selected.worst));
  const bestLater = sim.trips.find((t) => t.departure > selected.departure && t.worst === "seco") ?? better;
  const choose = $("choose-better");
  choose.hidden = !bestLater;
  choose.textContent = bestLater ? `Comparar saída às ${fmtTime(bestLater.departure)} →` : "";
  choose.onclick = bestLater ? () => {
    state.selected = bestLater;
    render();
    const button = els.bars.children[sim.trips.indexOf(bestLater)];
    button.focus({ preventScroll: true });
    button.scrollIntoView({ block: "nearest", inline: "nearest" });
  } : null;
  els.vTime.textContent = `Saída ${fmtWhen(selected.departure)}${isLive && selected === sim.trips[0] ? " · consulta para sair agora" : ""}`;
  $("departure-time").textContent = fmtTime(selected.departure);
  const arrival = selected.departure + r.duration * 1000;
  $("arrival-time").textContent = fmtTime(arrival);
  if (localInputValue(arrival).slice(0, 10) !== localInputValue(selected.departure).slice(0, 10)) {
    $("arrival-time").append(el("small", "arrival-day", fmtWhen(arrival).split(",")[0]));
  }
  const minutes = Math.round(r.duration / 60);
  $("trip-duration").textContent = minutes >= 60 ? `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ""}` : `${minutes} min`;
  const note = pastNote(selected);
  els.pastNote.hidden = !note;
  els.pastNote.textContent = note;

  if (renderedSim !== sim) {
    els.bars.replaceChildren();
    sim.trips.forEach((t) => {
      const b = el("button", `bar ${t.worst}`);
      b.type = "button";
      b.setAttribute("aria-label", `Sair ${fmtWhen(t.departure)}: ${CLASSES[t.worst].label}`);
      b.append(el("span", "t", fmtTime(t.departure)));
      // Keep the date when the comparison crosses midnight.
      if (localInputValue(t.departure).slice(0, 10) !== localInputValue(sim.trips[0].departure).slice(0, 10)) {
        b.append(el("span", "day", fmtWhen(t.departure).split(",")[0]));
      }
      b.append(weatherIcon(t.worst), el("span", "condition", CLASSES[t.worst].label));
      b.addEventListener("click", () => {
        state.selected = t;
        render();
      });
      els.bars.append(b);
    });
    renderedSim = sim;
    els.bars.scrollLeft = 0;
  }
  sim.trips.forEach((t, i) => {
    const b = els.bars.children[i];
    b.classList.toggle("selected", t === selected);
    b.setAttribute("aria-pressed", String(t === selected));
  });
  $("comparison-note").textContent = `${sim.trips.length} saídas, a cada ${sim.stepMin} min · ${fmtTime(sim.trips[0].departure)} a ${fmtTime(sim.trips.at(-1).departure)}.`;
  requestAnimationFrame(updateScrollControls);
  $("announcement").textContent = `Saída ${fmtWhen(selected.departure)}. ${els.vTitle.textContent}. ${v.detail} Chegada prevista às ${fmtTime(arrival)}.`;

  const weatherPoint = selected.worst === "forte" ? selected.worstLeg : selected.firstWet;
  const middle = weatherPoint && weatherPoint.frac > 0 && weatherPoint.frac < 1 ? weatherPoint : selected.legs[Math.floor(selected.legs.length / 2)];
  const points = [selected.legs[0], middle, selected.legs.at(-1)];
  $("journey-points").replaceChildren(...points.map((leg, i) => {
    const point = el("li");
    const name = i === 0 ? "Saída · A" : i === points.length - 1 ? "Chegada · B" : `km ${fmtKm(leg.km)}`;
    const weather = el("span", `journey-weather ${leg.cls}`);
    weather.append(weatherIcon(leg.cls), el("span", null, CLASSES[leg.cls].label));
    point.append(el("strong", null, name), el("span", "journey-time", fmtTime(leg.epoch)), weather);
    return point;
  }));
  $("journey-distance").textContent = `${fmtKm(r.distance / 1000)} km`;

  els.fromName.textContent = shortName(from.name);
  els.toName.textContent = shortName(to.name);
  $("duration-mode").textContent = VEHICLES[data.vehicle].label;
  $("summary-from").textContent = from.name.split(",")[0];
  $("summary-to").textContent = to.name.split(",")[0];
  const mode = document.querySelector(`[name="vehicle"][value="${data.vehicle}"] + span`).textContent;
  $("summary-meta").textContent = `· ${fmtTime(selected.departure)} · ${mode} ·`;
  $("trip-summary").dataset.trip = `${from.name} → ${to.name} · ${fmtWhen(selected.departure)} · ${mode}`;
  syncSummaryLabel();
  els.vRoute.textContent = `${fmtKm(r.distance / 1000)} km, cerca de ${Math.round(r.duration / 60)} min.`;
  els.sourceNote.textContent = radar
    ? `Até ${HORIZON_MIN} min depois da última imagem do radar (${fmtTime(radar.latest.time)}), a resposta vem do radar: onde está chovendo e para onde a chuva está indo. Depois disso, vem da previsão da Open-Meteo, que é regional.`
    : "O radar não carregou agora, então a resposta vem só da previsão da Open-Meteo, que é regional.";
  $("forecast-kind").textContent = selected.legs.some((l) => l.src !== "modelo") ? "Radar + previsão" : "Previsão regional";
  $("data-note").textContent = radar ? "Estimativa em pontos da rota. Consulte os detalhes para ver as fontes e os limites da previsão." : "Radar indisponível nesta consulta. A estimativa usa a previsão regional da Open-Meteo.";

  if (data.vehicle === "motorcycle") $("data-note").textContent += ` ${VEHICLES[data.vehicle].note}`;

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

function endpointPopup(title, name) {
  const content = el("div");
  content.append(el("strong", null, title), el("br"), document.createTextNode(shortName(name)));
  return content;
}

function divIcon(className, html) {
  return L.divIcon({
    className, html: `<span>${html}</span>`,
    ...(className === "pin" ? { iconSize: [44, 44], iconAnchor: [22, 44] } : { iconSize: null }),
  });
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
  if (!window.L) {
    $("map").classList.add("map-unavailable");
    $("map").textContent = "O mapa não carregou. A previsão e os detalhes do trajeto continuam disponíveis.";
    $("fit-map").hidden = true;
    return;
  }
  if (!map) {
    map = L.map("map", { zoomControl: true, attributionControl: true, scrollWheelZoom: false });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      className: "base-tiles",
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).on("tileerror", () => {
      $("map-notice").hidden = false;
      $("map-notice").textContent = "O mapa de fundo não carregou por completo. A rota e os horários continuam disponíveis.";
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

  L.marker([data.from.lat, data.from.lon], { icon: divIcon("pin", "<b>A</b>"), title: "Origem", zIndexOffset: 1000 }).bindPopup(endpointPopup("Saída", data.from.name)).addTo(routeLayer);
  L.marker([data.to.lat, data.to.lon], { icon: divIcon("pin", "<b>B</b>"), title: "Destino", zIndexOffset: 1000 }).bindPopup(endpointPopup("Chegada", data.to.name)).addTo(routeLayer);

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

function updateScrollControls() {
  const hasOverflow = els.bars.scrollWidth > els.bars.clientWidth + 2;
  // Keep these controls focusable at the ends so scrolling does not discard keyboard focus.
  $("earlier").setAttribute("aria-disabled", String(!hasOverflow || els.bars.scrollLeft <= 2));
  $("later").setAttribute("aria-disabled", String(!hasOverflow || els.bars.scrollLeft + els.bars.clientWidth >= els.bars.scrollWidth - 2));
}
els.bars.addEventListener("scroll", updateScrollControls, { passive: true });
window.addEventListener("resize", updateScrollControls);
for (const [id, direction] of [["earlier", -1], ["later", 1]]) {
  $(id).addEventListener("click", () => {
    els.bars.scrollBy({ left: direction * els.bars.clientWidth * .8, behavior: "instant" });
  });
}
$("fit-map").addEventListener("click", () => {
  if (map && data) map.fitBounds(data.route.coords.map(([lon, lat]) => [lat, lon]), { padding: [36, 36], animate: false });
});
