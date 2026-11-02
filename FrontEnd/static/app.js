"use strict";

/* ==========================================================================
   Painel de trânsito: integração com a API FastAPI
   Consulta /api/resumo, /api/serie e /api/eventos a cada 5 segundos.
   ========================================================================== */

const INTERVALO_MS = 5000;
const MINUTOS_POR_PERIODO = { "1h": 60, "6h": 360, "24h": 1440 };
const NOMES_TIPO = {
  freada_brusca: { texto: "Freada brusca", classe: "tipo--freada" },
  acima_velocidade: { texto: "Acima da velocidade", classe: "tipo--acima" },
};

const estado = {
  periodo: "1h",
  carregando: false,
  pedido: 0,          // evita que uma resposta antiga sobrescreva uma nova
  limite: null,
  valorGauge: 0,
};

const $ = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat("pt-BR");
const fmt1 = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });
const reduzirMovimento = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const estilo = getComputedStyle(document.documentElement);
const cor = (nome) => estilo.getPropertyValue(nome).trim();

/* --------------------------------------------------------------------------
   API
   -------------------------------------------------------------------------- */
const API_URL = "http://127.0.0.1:8000";

async function buscar(caminho) {
    const resposta = await fetch(`${API_URL}${caminho}`, {
        headers: {
            Accept: "application/json"
        }
    });

    if (!resposta.ok) {
        throw new Error(`${caminho}: HTTP ${resposta.status}`);
    }

    return resposta.json();
}

async function atualizar(forcar = false) {
  if (!forcar && (estado.carregando || document.hidden)) return;
  estado.carregando = true;
  const pedido = ++estado.pedido;
  const periodo = estado.periodo;

  try {
    const [resumo, serie, eventos] = await Promise.all([
      buscar(`/api/resumo?periodo=${periodo}`),
      buscar(`/api/serie?periodo=${periodo}`),
      buscar("/api/eventos"),
    ]);
    if (pedido !== estado.pedido || periodo !== estado.periodo) return;

    mostrarResumo(resumo);
    mostrarGraficos(serie, resumo);
    mostrarEventos(eventos);
    definirStatus(true, `Ao vivo, atualizado às ${hora(resumo.atualizado_em)}`);
  } catch (erro) {
    console.error(erro);
    definirStatus(false, "Sem conexão com a API. Tentando novamente…");
  } finally {
    if (pedido === estado.pedido) estado.carregando = false;
  }
}

/* --------------------------------------------------------------------------
   Utilitários de tela
   -------------------------------------------------------------------------- */
function hora(iso) {
  return new Date(iso).toLocaleTimeString("pt-BR");
}

function definirStatus(online, texto) {
  const status = $("status");
  status.classList.toggle("online", online);
  status.classList.toggle("offline", !online);
  $("status-texto").textContent = texto;
}

function porcento(parte, total) {
  return total > 0 ? (parte / total) * 100 : 0;
}

/* --------------------------------------------------------------------------
   Velocímetro (SVG)
   -------------------------------------------------------------------------- */
const G = { cx: 160, cy: 170, raio: 120, max: 120 };

function pontoNoArco(valor, raio) {
  const graus = 180 + (Math.min(Math.max(valor, 0), G.max) / G.max) * 180;
  const rad = (graus * Math.PI) / 180;
  return [G.cx + raio * Math.cos(rad), G.cy + raio * Math.sin(rad)];
}

function caminhoArco(de, ate) {
  if (ate <= de) return "";
  const [x1, y1] = pontoNoArco(de, G.raio);
  const [x2, y2] = pontoNoArco(ate, G.raio);
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${G.raio} ${G.raio} 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

function montarVelocimetro(limite) {
  estado.limite = limite;
  $("g-trilha-ok").setAttribute("d", caminhoArco(0, limite));
  $("g-trilha-alto").setAttribute("d", caminhoArco(limite, G.max));

  const [x1, y1] = pontoNoArco(limite, G.raio - 15);
  const [x2, y2] = pontoNoArco(limite, G.raio + 15);
  const marca = $("g-limite");
  marca.setAttribute("x1", x1);
  marca.setAttribute("y1", y1);
  marca.setAttribute("x2", x2);
  marca.setAttribute("y2", y2);

  const [tx, ty] = pontoNoArco(limite, G.raio + 28);
  const rotulo = $("g-limite-texto");
  rotulo.setAttribute("x", tx);
  rotulo.setAttribute("y", ty);
  rotulo.textContent = `limite ${limite}`;
}

function desenharVelocimetro(valor) {
  $("g-valor").setAttribute("d", caminhoArco(0, valor));
  $("g-valor").classList.toggle("alto", estado.limite !== null && valor > estado.limite);
  $("g-numero").textContent = Math.round(valor);
}

function moverVelocimetro(destino) {
  const origem = estado.valorGauge;
  estado.valorGauge = destino;
  $("gauge").setAttribute(
    "aria-label",
    `Velocidade média de ${Math.round(destino)} km/h, limite de ${estado.limite} km/h`
  );

  if (reduzirMovimento || origem === destino) {
    desenharVelocimetro(destino);
    return;
  }
  const inicio = performance.now();
  const duracao = 600;
  const passo = (agora) => {
    const t = Math.min((agora - inicio) / duracao, 1);
    const suave = 1 - Math.pow(1 - t, 3);
    desenharVelocimetro(origem + (destino - origem) * suave);
    if (t < 1 && estado.valorGauge === destino) requestAnimationFrame(passo);
  };
  requestAnimationFrame(passo);
}

/* --------------------------------------------------------------------------
   Números e barras
   -------------------------------------------------------------------------- */
function mostrarResumo(r) {
  $("via").textContent = r.via;
  $("limite").textContent = r.limite_velocidade;

  if (estado.limite !== r.limite_velocidade) montarVelocimetro(r.limite_velocidade);
  moverVelocimetro(r.velocidade_media);

  const pctOk = porcento(r.na_velocidade, r.carros_passados);
  const pctAcima = porcento(r.acima_velocidade, r.carros_passados);
  const porMinuto = r.carros_passados / MINUTOS_POR_PERIODO[r.periodo];
  const porMil = porcento(r.freadas_bruscas, r.carros_passados) * 10;

  $("k-carros").textContent = fmt.format(r.carros_passados);
  $("k-carros-sub").textContent = `cerca de ${fmt1.format(porMinuto)} por minuto`;

  $("k-ok").textContent = fmt.format(r.na_velocidade);
  $("k-ok-sub").textContent = `${fmt1.format(pctOk)}% dos carros`;
  $("k-ok-barra").style.width = `${pctOk}%`;

  $("k-acima").textContent = fmt.format(r.acima_velocidade);
  $("k-acima-sub").textContent = `${fmt1.format(pctAcima)}% dos carros`;
  $("k-acima-barra").style.width = `${pctAcima}%`;

  $("k-freadas").textContent = fmt.format(r.freadas_bruscas);
  $("k-freadas-sub").textContent = `${fmt1.format(porMil)} a cada mil carros`;

  $("d-pct").textContent = `${Math.round(pctOk)}%`;
  $("d-ok").textContent = fmt.format(r.na_velocidade);
  $("d-acima").textContent = fmt.format(r.acima_velocidade);
}

/* --------------------------------------------------------------------------
   Gráficos (Chart.js)
   -------------------------------------------------------------------------- */
let graficoFluxo, graficoRosca, graficoFreadas;

function configurarChartJs() {
  Chart.defaults.color = cor("--suave");
  Chart.defaults.font.family = cor("--fonte-txt");
  Chart.defaults.font.size = 13;
  Chart.defaults.borderColor = "rgba(58, 70, 81, 0.7)";
  Chart.defaults.animation.duration = reduzirMovimento ? 0 : 500;
}

function criarGraficos() {
  configurarChartJs();

  graficoFluxo = new Chart($("grafico-fluxo"), {
    data: {
      labels: [],
      datasets: [
        {
          type: "bar",
          label: "Carros",
          data: [],
          backgroundColor: cor("--ceu"),
          borderRadius: 2,
          yAxisID: "y",
          order: 3,
        },
        {
          type: "line",
          label: "Velocidade média (km/h)",
          data: [],
          borderColor: cor("--texto"),
          backgroundColor: cor("--texto"),
          borderWidth: 2.5,
          tension: 0.3,
          pointRadius: 3,
          yAxisID: "y1",
          order: 1,
        },
        {
          type: "line",
          label: "Limite (km/h)",
          data: [],
          borderColor: cor("--vermelho"),
          borderWidth: 2,
          borderDash: [6, 6],
          pointRadius: 0,
          yAxisID: "y1",
          order: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { position: "bottom", labels: { usePointStyle: true, boxWidth: 8 } } },
      scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: true, title: { display: true, text: "Carros" } },
        y1: {
          position: "right",
          beginAtZero: true,
          suggestedMax: 80,
          grid: { drawOnChartArea: false },
          title: { display: true, text: "km/h" },
        },
      },
    },
  });

  graficoRosca = new Chart($("grafico-rosca"), {
    type: "doughnut",
    data: {
      labels: ["Na velocidade", "Acima da velocidade"],
      datasets: [{ data: [0, 0], backgroundColor: [cor("--verde"), cor("--vermelho")], borderWidth: 0 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "72%",
      plugins: { legend: { display: false } },
    },
  });

  graficoFreadas = new Chart($("grafico-freadas"), {
    type: "bar",
    data: {
      labels: [],
      datasets: [{ label: "Freadas bruscas", data: [], backgroundColor: cor("--amarelo"), borderRadius: 2 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: true, ticks: { precision: 0 } },
      },
    },
  });
}

function mostrarGraficos(serie, resumo) {
  graficoFluxo.data.labels = serie.rotulos;
  graficoFluxo.data.datasets[0].data = serie.carros;
  graficoFluxo.data.datasets[1].data = serie.velocidade_media;
  graficoFluxo.data.datasets[2].data = serie.rotulos.map(() => resumo.limite_velocidade);
  graficoFluxo.update();

  graficoRosca.data.datasets[0].data = [resumo.na_velocidade, resumo.acima_velocidade];
  graficoRosca.update();

  graficoFreadas.data.labels = serie.rotulos;
  graficoFreadas.data.datasets[0].data = serie.freadas_bruscas;
  graficoFreadas.update();
}

/* --------------------------------------------------------------------------
   Tabela de ocorrências
   -------------------------------------------------------------------------- */
function celula(texto, classe) {
  const td = document.createElement("td");
  if (classe) td.className = classe;
  td.textContent = texto;
  return td;
}

function mostrarEventos(eventos) {
  const corpo = $("eventos");
  corpo.replaceChildren();

  if (!eventos.length) {
    const linha = document.createElement("tr");
    const td = celula("Nenhuma ocorrência recente.", "vazio");
    td.colSpan = 4;
    linha.append(td);
    corpo.append(linha);
    return;
  }

  for (const e of eventos) {
    const tipo = NOMES_TIPO[e.tipo] ?? { texto: e.tipo, classe: "" };
    const linha = document.createElement("tr");

    const colunaTipo = document.createElement("td");
    const rotulo = document.createElement("span");
    rotulo.className = `tipo ${tipo.classe}`;
    rotulo.textContent = tipo.texto;
    colunaTipo.append(rotulo);

    linha.append(
      celula(hora(e.horario)),
      colunaTipo,
      celula(`Faixa ${e.faixa}`),
      celula(`${e.velocidade} km/h`)
    );
    corpo.append(linha);
  }
}

/* --------------------------------------------------------------------------
   Início
   -------------------------------------------------------------------------- */
function ligarSeletorDePeriodo() {
  const botoes = document.querySelectorAll(".periodos button");
  botoes.forEach((botao) => {
    botao.addEventListener("click", () => {
      if (botao.dataset.periodo === estado.periodo) return;
      estado.periodo = botao.dataset.periodo;
      botoes.forEach((b) => b.setAttribute("aria-pressed", String(b === botao)));
      atualizar(true);
    });
  });
}

document.addEventListener("DOMContentLoaded", () => {
  criarGraficos();
  ligarSeletorDePeriodo();
  atualizar();
  setInterval(atualizar, INTERVALO_MS);
  conectarSensores();
  atualizarUltimos();
  setInterval(() => { if (!document.hidden) atualizarUltimos(); }, 2000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) atualizar();
  });
});

/* --------------------------------------------------------------------------
   Sensores ao vivo (WebSocket) e últimos veículos
   Cada sensor acende ao detectar e apaga quando o próximo dispara (1 -> 2 -> 3).
   O sensor 3 apaga sozinho depois de um instante, esperando o próximo veículo.
   -------------------------------------------------------------------------- */
const WS_URL = API_URL.replace(/^http/, "ws") + "/ws/sensores";
const MIN_VERDE_MS = 350;   // tempo mínimo aceso, senão a detecção (milissegundos) nem aparece
const MAX_VERDE_MS = { 1: 2000, 2: 2000, 3: 1200 };  // sem o próximo sensor, apaga sozinho

const sensores = {
  1: { ligado: false, desde: 0, timer: null },
  2: { ligado: false, desde: 0, timer: null },
  3: { ligado: false, desde: 0, timer: null },
};

function pintarSensor(n, ativo) {
  const el = $(`sensor-${n}`);
  if (!el) return;
  el.classList.toggle("ativo", ativo);
  $(`st-${n}`).textContent = ativo ? "Detectou" : "Livre";
}

function acenderSensor(n) {
  const s = sensores[n];
  clearTimeout(s.timer);
  if (!s.ligado) {
    s.ligado = true;
    s.desde = performance.now();
    pintarSensor(n, true);
  }
  // se nenhum sensor seguinte disparar, apaga sozinho depois de um tempo
  s.timer = setTimeout(() => apagarSensor(n, false), MAX_VERDE_MS[n]);
}

function apagarSensor(n, respeitarMinimo = true) {
  const s = sensores[n];
  clearTimeout(s.timer);
  if (!s.ligado) return;
  const espera = respeitarMinimo
    ? Math.max(0, s.desde + MIN_VERDE_MS - performance.now())
    : 0;
  s.timer = setTimeout(() => {
    s.ligado = false;
    pintarSensor(n, false);
  }, espera);
}

function aoReceberSensor(det) {
  if (det.detectou === false) return;   // só as detecções mexem na tela
  const n = det.sensor;
  if (!sensores[n]) return;

  acenderSensor(n);

  // Um sensor apaga quando o próximo dispara.
  // Sensor 1 = começou outro veículo: apaga o 2 e o 3 que ainda sobraram.
  if (n === 1) {
    apagarSensor(2);
    apagarSensor(3);
  } else {
    for (let anterior = 1; anterior < n; anterior++) apagarSensor(anterior);
  }

  // o carro é registrado quando o sensor 3 dispara: busca os dados logo depois
  if (n === 3) setTimeout(atualizarUltimos, 250);
}

function apagarSensores() {
  for (const n of [1, 2, 3]) {
    const s = sensores[n];
    clearTimeout(s.timer);
    s.ligado = false;
    pintarSensor(n, false);
  }
}

function conectarSensores() {
  const aviso = $("rodovia-status");
  let ws;
  try {
    ws = new WebSocket(WS_URL);
  } catch (erro) {
    console.error(erro);
    setTimeout(conectarSensores, 3000);
    return;
  }

  ws.onopen = () => { aviso.textContent = "Sensores ao vivo"; };
  ws.onmessage = (ev) => {
    try {
      aoReceberSensor(JSON.parse(ev.data));
    } catch (erro) {
      console.error(erro);
    }
  };
  ws.onerror = () => ws.close();
  ws.onclose = () => {
    apagarSensores();
    aviso.textContent = "Sem sinal dos sensores. Reconectando…";
    setTimeout(conectarSensores, 3000);
  };
}

/* ---------- Últimos 3 veículos ---------- */
const fmt2 = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function classificarVeiculo(v) {
  if (v.acima && v.freada) return { classe: "veiculo--ambos", texto: "Acima da velocidade e freada brusca" };
  if (v.acima) return { classe: "veiculo--acima", texto: "Acima da velocidade" };
  if (v.freada) return { classe: "veiculo--freada", texto: "Freada brusca" };
  return { classe: "veiculo--ok", texto: "Na velocidade" };
}

let pedidoUltimos = 0;
let ultimoHorario = null;

async function atualizarUltimos() {
  const pedido = ++pedidoUltimos;
  try {
    const lista = await buscar("/api/ultimos");
    if (pedido !== pedidoUltimos) return;
    mostrarUltimos(lista);
  } catch (erro) {
    console.error(erro);
  }
}

function mostrarUltimos(lista) {
  const ul = $("veiculos");

  if (!lista.length) {
    ul.replaceChildren();
    const li = document.createElement("li");
    li.className = "vazio-lista";
    li.textContent = "Aguardando veículos…";
    ul.append(li);
    return;
  }

  const horarioNovo = lista[0].horario;
  if (horarioNovo === ultimoHorario) return;   // nada mudou
  const chegouNovo = ultimoHorario !== null;
  ultimoHorario = horarioNovo;

  ul.replaceChildren();
  lista.forEach((v, i) => {
    const tipo = classificarVeiculo(v);
    const li = document.createElement("li");
    li.className = `veiculo ${tipo.classe}`;
    if (i === 0 && chegouNovo) li.classList.add("novo");

    const vel = document.createElement("div");
    vel.className = "veiculo-vel";
    const num = document.createElement("strong");
    num.textContent = Math.round(v.velocidade);
    const un = document.createElement("span");
    un.textContent = "km/h";
    vel.append(num, un);

    const info = document.createElement("div");
    info.className = "veiculo-info";
    const status = document.createElement("b");
    status.textContent = tipo.texto;
    const detalhe = document.createElement("span");
    const sinal = v.aceleracao > 0 ? "+" : "";
    detalhe.textContent = `${hora(v.horario)} · ${sinal}${fmt2.format(v.aceleracao)} m/s²`;
    info.append(status, detalhe);

    li.append(vel, info);
    ul.append(li);
  });
}