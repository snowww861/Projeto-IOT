import serial
from simulada import SerialSimulada
from datetime import datetime
import re


esp = SerialSimulada("COM4", 115200, timeout=1)
LIMITE_SIMULTANEO = 0.005

PADRAO = re.compile(r"Sensor (\d) (detectou|nada)")

validos = []   # leituras completas e válidas: {1: hora, 2: hora, 3: hora}
tentativa = {} # sequência em andamento


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

try:
    while True:
        if esp.in_waiting > 0:
            mensagem = esp.readline().decode("utf-8", errors="ignore").strip()
            m = PADRAO.search(mensagem)
            if m:
                hora = datetime.now()
                sensor = int(m.group(1))
                detectou = m.group(2) == "detectou"

                if detectou:
                    print(f"{hora} {mensagem}")

                tentativa, completa = processar_evento(tentativa, sensor, detectou, hora)

                if completa:
                    intervalo = (completa[3] - completa[1]).total_seconds()
                    if intervalo <= LIMITE_SIMULTANEO:
                        pass  # os 3 ao mesmo tempo: descarta
                    else:
                        validos.append(completa)
                        print("encontrado")
except KeyboardInterrupt:
    print(validos)
    print(id)
    print("\nLeitura encerrada.")

finally:
    esp.close()