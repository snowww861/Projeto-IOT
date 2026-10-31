"""
Painel de trânsito inteligente: API em FastAPI + leitura dos sensores (ESP).

Como rodar:
    pip install -r requirements.txt   # fastapi, uvicorn, pyserial
    uvicorn main:app --reload
Depois abra http://127.0.0.1:8000

Endpoints:
    GET /                 -> a interface (static/index.html)
    GET /api/resumo       -> números principais do período
    GET /api/serie        -> série temporal para os gráficos
    GET /api/eventos      -> ocorrências recentes (freadas e excessos de velocidade)
    GET /docs             -> documentação interativa gerada pelo FastAPI

Cada carro só é contado quando passa pelos sensores 1 -> 2 -> 3 em sequência.
Com as distâncias entre sensores calculamos as velocidades e a aceleração.
"""
from __future__ import annotations

import re
import threading
import time
from collections import deque
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Literal

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from fastapi.middleware.cors import CORSMiddleware

BASE_DIR = Path(__file__).parent
STATIC_DIR = BASE_DIR / "static"

VIA = "Av. Brasil, trecho 3"
LIMITE_VELOCIDADE = 60  # km/h

# ---------------- Sensores ----------------
USAR_SERIAL_REAL = False      # True -> usa a porta serial de verdade
PORTA = "COM4"
BAUD = 115200

DIST_1_2 = 0.23               # metros entre sensor 1 e 2
DIST_2_3 = 0.21               # metros entre sensor 2 e 3
LIMITE_SIMULTANEO = 0.005     # s: se 1 e 3 disparam quase juntos, descarta
LIMITE_FREADA = 3.0           # m/s² de desaceleração para contar freada brusca
VELOCIDADE_MAXIMA_VALIDA = 250  # km/h: acima disso é ruído, descarta
FAIXA = 1                     # os sensores não identificam a faixa; ajuste se precisar

PADRAO = re.compile(r"Sensor (\d) (detectou|nada)")

Periodo = Literal["1h", "6h", "24h"]
# periodo -> (quantidade de intervalos, minutos por intervalo)
CONFIG_PERIODO: dict[str, tuple[int, int]] = {
    "1h": (12, 5),
    "6h": (12, 30),
    "24h": (24, 60),
}


# --------------------------------------------------------------------------
# Modelos: este é o contrato entre a API e a interface
# --------------------------------------------------------------------------
class Resumo(BaseModel):
    via: str
    limite_velocidade: int
    periodo: Periodo
    carros_passados: int
    na_velocidade: int
    acima_velocidade: int
    freadas_bruscas: int
    velocidade_media: float
    atualizado_em: datetime


class Serie(BaseModel):
    rotulos: list[str]
    carros: list[int]
    velocidade_media: list[float]
    acima_velocidade: list[int]
    freadas_bruscas: list[int]


class Evento(BaseModel):
    horario: datetime
    tipo: Literal["freada_brusca", "acima_velocidade"]
    faixa: int
    velocidade: int


# --------------------------------------------------------------------------
# Lógica dos sensores
# --------------------------------------------------------------------------
@dataclass
class Passagem:
    horario: datetime      # momento em que o carro saiu do sensor 3
    velocidade: float      # km/h (média no trecho 1->3)
    aceleracao: float      # m/s² (negativa = freando)
    acima: bool
    freada: bool


def processar_evento(tentativa, sensor, detectou, hora):
    """
    Recebe a tentativa atual e um evento. Retorna (nova_tentativa, completa).
    'completa' é o dict {1:..., 2:..., 3:...} quando fecha uma sequência, senão None.
    """
    # "nada detectado" no meio da sequência quebra a tentativa
    if not detectou:
        return {}, None

    esperado = len(tentativa) + 1

    # Sensor 1 só inicia se não houver tentativa. Se vier outro 1 em seguida, invalida.
    if sensor == 1:
        if tentativa:
            return {}, None
        return {1: hora}, None

    # Sensores 2 e 3 só valem se forem exatamente o próximo da sequência
    if sensor != esperado:
        return {}, None

    tentativa[sensor] = hora
    if sensor == 3:
        return {}, dict(tentativa)
    return tentativa, None


def calcular_passagem(leitura: dict[int, datetime]) -> Passagem | None:
    """Converte os 3 horários em velocidade e aceleração. None se for inválida."""
    t1, t2, t3 = leitura[1], leitura[2], leitura[3]

    if (t3 - t1).total_seconds() <= LIMITE_SIMULTANEO:
        return None  # os 3 ao mesmo tempo: descarta

    dt12 = (t2 - t1).total_seconds()
    dt23 = (t3 - t2).total_seconds()
    if dt12 <= 0 or dt23 <= 0:
        return None

    v12 = DIST_1_2 / dt12                       # m/s no primeiro trecho
    v23 = DIST_2_3 / dt23                       # m/s no segundo trecho
    v_med = (DIST_1_2 + DIST_2_3) / (dt12 + dt23)

    # v12 vale no meio do 1º trecho e v23 no meio do 2º; entre os dois
    # pontos médios passa (dt12 + dt23) / 2 segundos.
    aceleracao = (v23 - v12) / ((dt12 + dt23) / 2)

    kmh = v_med * 3.6
    if kmh > VELOCIDADE_MAXIMA_VALIDA:
        return None

    return Passagem(
        horario=t3,
        velocidade=kmh,
        aceleracao=aceleracao,
        acima=kmh > LIMITE_VELOCIDADE,
        freada=aceleracao <= -LIMITE_FREADA,
    )


# Armazenamento compartilhado entre a thread da serial e a API
_passagens: deque[Passagem] = deque()
_lock = threading.Lock()


def _registrar(p: Passagem) -> None:
    corte = datetime.now() - timedelta(hours=25)
    with _lock:
        _passagens.append(p)
        while _passagens and _passagens[0].horario < corte:
            _passagens.popleft()


def _copia_passagens() -> list[Passagem]:
    with _lock:
        return list(_passagens)


class LeitorSerial(threading.Thread):
    def __init__(self) -> None:
        super().__init__(daemon=True)
        self._parar = threading.Event()

    def parar(self) -> None:
        self._parar.set()

    def _abrir(self):
        if USAR_SERIAL_REAL:
            import serial
            return serial.Serial(PORTA, BAUD, timeout=1)
        from simulada import SerialSimulada
        return SerialSimulada(PORTA, BAUD, timeout=1)

    def run(self) -> None:
        try:
            esp = self._abrir()
        except Exception as erro:
            print(f"Não foi possível abrir a serial: {erro}")
            return

        tentativa: dict[int, datetime] = {}
        try:
            while not self._parar.is_set():
                if esp.in_waiting <= 0:
                    time.sleep(0.001)
                    continue

                mensagem = esp.readline().decode("utf-8", errors="ignore").strip()
                m = PADRAO.search(mensagem)
                if not m:
                    continue

                hora = datetime.now()
                sensor = int(m.group(1))
                detectou = m.group(2) == "detectou"
                if detectou:
                    print(f"{hora} {mensagem}")

                tentativa, completa = processar_evento(tentativa, sensor, detectou, hora)
                if completa:
                    passagem = calcular_passagem(completa)
                    if passagem:
                        _registrar(passagem)
                        print(
                            f"encontrado: {passagem.velocidade:.1f} km/h, "
                            f"{passagem.aceleracao:+.2f} m/s²"
                        )
        finally:
            esp.close()


# --------------------------------------------------------------------------
# FONTE DE DADOS (agora real, vinda dos sensores)
# --------------------------------------------------------------------------
def _inicio_primeiro_intervalo(periodo: str) -> tuple[datetime, int, int]:
    quantidade, minutos = CONFIG_PERIODO[periodo]
    agora = datetime.now().replace(second=0, microsecond=0)
    inicio_atual = agora - timedelta(minutes=agora.minute % minutos)
    primeiro = inicio_atual - timedelta(minutes=minutos * (quantidade - 1))
    return primeiro, quantidade, minutos


def serie_do_periodo(periodo: str) -> Serie:
    primeiro, quantidade, minutos = _inicio_primeiro_intervalo(periodo)
    passo = timedelta(minutes=minutos)

    carros = [0] * quantidade
    soma_vel = [0.0] * quantidade
    acima = [0] * quantidade
    freadas = [0] * quantidade

    for p in _copia_passagens():
        i = int((p.horario - primeiro) / passo)
        if not 0 <= i < quantidade:
            continue
        carros[i] += 1
        soma_vel[i] += p.velocidade
        acima[i] += p.acima
        freadas[i] += p.freada

    return Serie(
        rotulos=[(primeiro + passo * i).strftime("%H:%M") for i in range(quantidade)],
        carros=carros,
        velocidade_media=[
            round(soma_vel[i] / carros[i], 1) if carros[i] else 0.0
            for i in range(quantidade)
        ],
        acima_velocidade=acima,
        freadas_bruscas=freadas,
    )


def resumo_do_periodo(periodo: str) -> Resumo:
    primeiro, _, _ = _inicio_primeiro_intervalo(periodo)
    doperiodo = [p for p in _copia_passagens() if p.horario >= primeiro]

    total = len(doperiodo)
    acima = sum(p.acima for p in doperiodo)
    media = sum(p.velocidade for p in doperiodo) / total if total else 0.0

    return Resumo(
        via=VIA,
        limite_velocidade=LIMITE_VELOCIDADE,
        periodo=periodo,  # type: ignore[arg-type]
        carros_passados=total,
        na_velocidade=total - acima,
        acima_velocidade=acima,
        freadas_bruscas=sum(p.freada for p in doperiodo),
        velocidade_media=round(media, 1),
        atualizado_em=datetime.now(),
    )


def eventos_recentes(limite: int = 8) -> list[Evento]:
    eventos: list[Evento] = []
    for p in reversed(_copia_passagens()):
        for tipo, ocorreu in (("freada_brusca", p.freada), ("acima_velocidade", p.acima)):
            if ocorreu:
                eventos.append(
                    Evento(
                        horario=p.horario,
                        tipo=tipo,  # type: ignore[arg-type]
                        faixa=FAIXA,
                        velocidade=round(p.velocidade),
                    )
                )
        if len(eventos) >= limite:
            break
    return eventos[:limite]


# --------------------------------------------------------------------------
# Aplicação
# --------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(_: FastAPI):
    leitor = LeitorSerial()
    leitor.start()
    yield
    leitor.parar()
    leitor.join(timeout=3)


app = FastAPI(
    title="Painel de trânsito inteligente",
    lifespan=lifespan
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:5500",
        "http://localhost:5500"
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/resumo", response_model=Resumo)
def api_resumo(periodo: Periodo = "1h") -> Resumo:
    return resumo_do_periodo(periodo)


@app.get("/api/serie", response_model=Serie)
def api_serie(periodo: Periodo = "1h") -> Serie:
    return serie_do_periodo(periodo)


@app.get("/api/eventos", response_model=list[Evento])
def api_eventos() -> list[Evento]:
    return eventos_recentes()


@app.get("/", include_in_schema=False)
def pagina_inicial() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")