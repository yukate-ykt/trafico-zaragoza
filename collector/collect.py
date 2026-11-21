#!/usr/bin/env python3
"""Recolector de datos abiertos de tráfico de Zaragoza.

Se ejecuta cada 10 minutos (GitHub Actions) y:
  1. Descarga las incidencias de la DGT (DATEX II v3.7) y se queda con las del área de Zaragoza.
  2. Descarga el inventario de cámaras de la DGT (una vez al día) y se queda con las de Zaragoza.
  3. Descarga los cortes e incidencias de vía pública y los tiempos de recorrido del Ayuntamiento.
  4. Guarda una "foto" de lo que está activo en docs/data/historico/AAAA-MM-DD.jsonl
  5. Recalcula docs/data/patrones.json (mapa de calor, horas y días, puntos recurrentes).

Solo usa la biblioteca estándar de Python, sin dependencias.
"""
import datetime as dt
import json
import os
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET
from collections import defaultdict
from zoneinfo import ZoneInfo

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "docs", "data")
HIST = os.path.join(DATA, "historico")
TZ = ZoneInfo("Europe/Madrid")

# Área de Zaragoza y sus accesos (Z-40, A-2, A-23, A-68, AP-68, N-232, N-330...)
BBOX = (41.50, 41.80, -1.15, -0.65)  # lat_min, lat_max, lon_min, lon_max

DGT_SITUACIONES = "https://nap.dgt.es/datex2/v3/dgt/SituationPublication/datex2_v37.xml"
DGT_CAMARAS = "https://nap.dgt.es/datex2/v3/dgt/DevicePublication/camaras_datex2_v37.xml"
ZGZ = "https://www.zaragoza.es/sede/servicio"
ZGZ_CORTES = ZGZ + "/via-publica/incidencia.json?rows=500&srsname=wgs84"
ZGZ_TIEMPOS = ZGZ + "/tiempos-recorrido.json?start=0&rows=-1&srsname=wgs84"
ZGZ_TRANVIA = ZGZ + "/urbanismo-infraestructuras/transporte-urbano/parada-tranvia.json?rows=200&srsname=wgs84"

UA = "trafico-zaragoza-opendata/1.0"

CAUSAS = {
    "roadMaintenance": "Obras",
    "vehicleObstruction": "Vehículo detenido / averiado",
    "obstruction": "Obstáculo en la vía",
    "environmentalObstruction": "Obstáculo ambiental",
    "accident": "Accidente",
    "infrastructureDamageObstruction": "Daños en la infraestructura",
    "poorEnvironment": "Meteorología adversa",
    "roadOrCarriagewayOrLaneManagement": "Regulación de carriles",
    "abnormalTraffic": "Retención / tráfico anormal",
}
GESTION = {
    "laneClosures": "Carril cortado",
    "roadClosed": "Carretera cortada",
    "carriagewayClosures": "Calzada cortada",
    "singleAlternateLineTraffic": "Paso alternativo",
    "narrowLanes": "Carriles estrechados",
    "contraflow": "Circulación en sentido contrario",
    "useOfSpecifiedLanesOrCarriagewaysAllowed": "Uso de carriles específicos",
    "doNotUseSpecifiedLanesOrCarriageways": "No usar carriles indicados",
}
DETALLES = {
    "roadworks": "Obras en la calzada", "maintenanceWork": "Mantenimiento", "resurfacingWork": "Reasfaltado",
    "vehicleStuck": "Vehículo detenido", "brokenDownVehicle": "Vehículo averiado", "vehicleOnFire": "Vehículo ardiendo",
    "accident": "Accidente", "collision": "Colisión", "objectsOnTheRoad": "Objetos en la calzada",
    "animalsOnTheRoad": "Animales en la calzada", "flooding": "Inundación", "fallenTrees": "Árboles caídos",
    "rockfalls": "Desprendimientos", "fog": "Niebla", "snowfall": "Nieve", "ice": "Hielo", "strongWinds": "Viento fuerte",
    "stationaryTraffic": "Tráfico detenido", "queuingTraffic": "Retención", "slowTraffic": "Tráfico lento",
    "heavyTraffic": "Tráfico denso",
}
NIVEL = {"highest": "Muy alto", "high": "Alto", "medium": "Medio", "low": "Bajo", "lowest": "Muy bajo"}


def now():
    return dt.datetime.now(TZ)


def get(url, timeout=90):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def local(tag):
    return tag.rsplit("}", 1)[-1]


def first(el, name):
    for e in el.iter():
        if local(e.tag) == name:
            return e
    return None


def text(el, name):
    e = first(el, name)
    return e.text.strip() if e is not None and e.text and e.text.strip() else None


def in_bbox(lat, lon):
    return BBOX[0] <= lat <= BBOX[1] and BBOX[2] <= lon <= BBOX[3]


def write_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


def read_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


# ---------------------------------------------------------------- DGT incidencias
def parse_point(el):
    lat, lon = text(el, "latitude"), text(el, "longitude")
    if lat is None or lon is None:
        return None
    return {
        "lat": float(lat),
        "lon": float(lon),
        "km": text(el, "kilometerPoint"),
        "municipio": text(el, "municipality"),
    }


def dgt_incidencias():
    root = ET.fromstring(get(DGT_SITUACIONES))
    pub = text(root, "publicationTime")
    out = []
    for sit in root.iter():
        if local(sit.tag) != "situation":
            continue
        rec = first(sit, "situationRecord")
        if rec is None:
            continue
        loc = first(rec, "locationReference")
        if loc is None:
            continue
        pts = []
        for e in loc.iter():
            if local(e.tag) in ("from", "to", "point"):
                p = parse_point(e)
                if p:
                    pts.append((local(e.tag), p))
        if not pts:
            p = parse_point(loc)
            if p:
                pts.append(("point", p))
        if not pts or not any(in_bbox(p["lat"], p["lon"]) for _, p in pts):
            continue
        d = dict(pts)
        a = d.get("from") or d.get("point") or pts[0][1]
        b = d.get("to") or a
        causa = text(rec, "causeType")
        detalle = None
        for e in rec.iter():
            n = local(e.tag)
            if n.endswith("Type") and n not in ("causeType", "detailedCauseType", "vehicleType") and e.text and e.text.strip():
                if n == "roadOrCarriagewayOrLaneManagementType":
                    continue
                detalle = e.text.strip()
                break
        gestion = text(rec, "roadOrCarriagewayOrLaneManagementType")
        rtype = None
        for k, v in rec.attrib.items():
            if local(k) == "type":
                rtype = v.split(":")[-1]
        comentarios = [e.text.strip() for e in rec.iter() if local(e.tag) == "value" and e.text and e.text.strip()]
        out.append({
            "id": sit.attrib.get("id"),
            "carretera": text(rec, "roadName"),
            "causa": causa,
            "tipo": CAUSAS.get(causa, causa or rtype or "Incidencia"),
            "detalle": DETALLES.get(detalle, detalle),
            "afeccion": GESTION.get(gestion, gestion),
            "nivel": NIVEL.get(text(rec, "severity") or "", None),
            "sentido": text(rec, "tpegDirectionRoad") or text(rec, "tpegDirection"),
            "inicio": text(rec, "overallStartTime"),
            "fin": text(rec, "overallEndTime"),
            "actualizado": text(rec, "situationRecordVersionTime"),
            "desde": a,
            "hasta": b,
            "comentario": " · ".join(comentarios)[:500] or None,
        })
    return {"fuente": "DGT – Punto de Acceso Nacional (DATEX II v3.7)", "publicado": pub, "incidencias": out}


# ---------------------------------------------------------------- DGT cámaras
def dgt_camaras():
    root = ET.fromstring(get(DGT_CAMARAS))
    out = []
    for dev in root.iter():
        if local(dev.tag) != "device":
            continue
        lat, lon = text(dev, "latitude"), text(dev, "longitude")
        url = text(dev, "deviceUrl")
        if not (lat and lon and url):
            continue
        lat, lon = float(lat), float(lon)
        if not in_bbox(lat, lon):
            continue
        out.append({
            "id": dev.attrib.get("id"),
            "carretera": text(dev, "roadName"),
            "destino": text(dev, "roadDestination"),
            "km": text(dev, "kilometerPoint"),
            "lat": lat,
            "lon": lon,
            "url": url,
        })
    return {"fuente": "DGT – Punto de Acceso Nacional (cámaras)", "camaras": out}


# ---------------------------------------------------------------- Ayuntamiento
def zgz_json(url):
    return json.loads(get(url).decode("utf-8"))


def strip_html(s):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", s or "")).strip()


def zgz_tiempos():
    d = zgz_json(ZGZ_TIEMPOS)
    out = []
    for r in d.get("result", []):
        g = r.get("geometry") or {}
        c = g.get("coordinates") or [None, None]
        out.append({
            "panel": (r.get("link") or "").split("#")[-1],
            "nombre": r.get("title"),
            "texto": strip_html(r.get("description")),
            "lon": c[0],
            "lat": c[1],
        })
    return out


def zgz_cortes():
    d = zgz_json(ZGZ_CORTES)
    out = []
    for r in d.get("result", []):
        g = (r.get("geometry") or {}).get("coordinates") or [None, None]
        tipo = None
        m = re.search(r"Tipo:\s*([^<]+)", r.get("description") or "")
        if m:
            tipo = m.group(1).strip()
        out.append({
            "id": r.get("id"),
            "calle": r.get("title"),
            "tipo": tipo,
            "inicio": r.get("inicio"),
            "fin": r.get("fin"),
            "lon": g[0],
            "lat": g[1],
        })
    return out


def zgz_tranvia():
    d = zgz_json(ZGZ_TRANVIA)
    out = []
    for r in d.get("result", []):
        mins = [x.get("minutos") for x in r.get("destinos") or [] if isinstance(x.get("minutos"), (int, float))]
        out.append({"id": r.get("id"), "parada": r.get("title"), "min": min(mins) if mins else None})
    return out


# ---------------------------------------------------------------- Histórico y patrones
def guardar_foto(t, inc, cortes, tiempos, tranvia):
    foto = {
        "t": t.isoformat(timespec="minutes"),
        "dgt": [
            {
                "id": i["id"],
                "c": i["causa"],
                "r": i["carretera"],
                "km": i["desde"].get("km"),
                "lat": round(i["desde"]["lat"], 5),
                "lon": round(i["desde"]["lon"], 5),
            }
            for i in inc
        ],
        "cortes": [c["id"] for c in cortes],
        "tiempos": {x["panel"]: x["texto"] for x in tiempos if x["texto"]},
        "tranvia": {x["id"]: x["min"] for x in tranvia if x["min"] is not None},
    }
    os.makedirs(HIST, exist_ok=True)
    path = os.path.join(HIST, t.strftime("%Y-%m-%d") + ".jsonl")
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(foto, ensure_ascii=False, separators=(",", ":")) + "\n")


def calcular_patrones():
    """Recorre todo el histórico y calcula los patrones."""
    archivos = sorted(f for f in os.listdir(HIST) if f.endswith(".jsonl"))
    # Matriz día de la semana (0=lunes) x hora: nº medio de incidencias activas y nº de incidencias nuevas
    suma = [[0] * 24 for _ in range(7)]
    fotos = [[0] * 24 for _ in range(7)]
    nuevas = [[0] * 24 for _ in range(7)]
    vistos = set()
    # Puntos recurrentes: celdas de ~500 m
    celdas = defaultdict(lambda: {"ids": set(), "dias": set(), "obs": 0, "causas": defaultdict(int), "carreteras": defaultdict(int), "lat": 0.0, "lon": 0.0})
    calor = defaultdict(int)
    n_fotos = 0
    primera = ultima = None
    for nombre in archivos:
        with open(os.path.join(HIST, nombre), encoding="utf-8") as f:
            for linea in f:
                try:
                    foto = json.loads(linea)
                except Exception:
                    continue
                t = dt.datetime.fromisoformat(foto["t"])
                primera = primera or foto["t"]
                ultima = foto["t"]
                n_fotos += 1
                wd, h = t.weekday(), t.hour
                fotos[wd][h] += 1
                suma[wd][h] += len(foto.get("dgt", []))
                for i in foto.get("dgt", []):
                    key = (round(i["lat"] / 0.005), round(i["lon"] / 0.005))
                    c = celdas[key]
                    c["obs"] += 1
                    c["lat"] += i["lat"]
                    c["lon"] += i["lon"]
                    c["dias"].add(t.date().isoformat())
                    calor[(round(i["lat"], 3), round(i["lon"], 3))] += 1
                    if i["id"] not in c["ids"]:
                        c["ids"].add(i["id"])
                        c["causas"][i.get("c") or "?"] += 1
                        c["carreteras"][i.get("r") or "?"] += 1
                    if i["id"] not in vistos:
                        vistos.add(i["id"])
                        nuevas[wd][h] += 1
    media = [[round(suma[d][h] / fotos[d][h], 2) if fotos[d][h] else None for h in range(24)] for d in range(7)]
    puntos = []
    for c in celdas.values():
        puntos.append({
            "lat": round(c["lat"] / c["obs"], 5),
            "lon": round(c["lon"] / c["obs"], 5),
            "incidencias": len(c["ids"]),
            "dias": len(c["dias"]),
            "observaciones": c["obs"],
            "carretera": max(c["carreteras"], key=c["carreteras"].get),
            "causas": {CAUSAS.get(k, k): v for k, v in c["causas"].items()},
        })
    puntos.sort(key=lambda p: (-p["incidencias"], -p["dias"], -p["observaciones"]))
    write_json(os.path.join(DATA, "patrones.json"), {
        "generado": now().isoformat(timespec="minutes"),
        "desde": primera,
        "hasta": ultima,
        "fotos": n_fotos,
        "dias": len(archivos),
        "incidencias_distintas": len(vistos),
        "media_activas": media,
        "nuevas": nuevas,
        "puntos": puntos[:200],
        "calor": [[k[0], k[1], v] for k, v in calor.items()],
    })


def main():
    os.makedirs(DATA, exist_ok=True)
    t = now()
    estado = read_json(os.path.join(DATA, "estado.json"), {})
    errores = {}

    inc = []
    try:
        r = dgt_incidencias()
        r["descargado"] = t.isoformat(timespec="seconds")
        write_json(os.path.join(DATA, "dgt_incidencias.json"), r)
        inc = r["incidencias"]
    except Exception as e:
        errores["dgt_incidencias"] = str(e)

    cam_path = os.path.join(DATA, "dgt_camaras.json")
    ult = estado.get("camaras_descargadas")
    if not os.path.exists(cam_path) or not ult or (t - dt.datetime.fromisoformat(ult)).total_seconds() > 86400:
        try:
            r = dgt_camaras()
            r["descargado"] = t.isoformat(timespec="seconds")
            write_json(cam_path, r)
            estado["camaras_descargadas"] = r["descargado"]
        except Exception as e:
            errores["dgt_camaras"] = str(e)

    cortes, tiempos, tranvia = [], [], []
    for nombre, fn in (("zgz_cortes", zgz_cortes), ("zgz_tiempos", zgz_tiempos), ("zgz_tranvia", zgz_tranvia)):
        try:
            v = fn()
            if nombre == "zgz_cortes":
                cortes = v
            elif nombre == "zgz_tiempos":
                tiempos = v
            else:
                tranvia = v
        except Exception as e:
            errores[nombre] = str(e)

    if "dgt_incidencias" not in errores:
        guardar_foto(t, inc, cortes, tiempos, tranvia)
    calcular_patrones()

    estado.update({"ultima_ejecucion": t.isoformat(timespec="seconds"), "errores": errores,
                   "incidencias_dgt": len(inc), "cortes_ayto": len(cortes)})
    write_json(os.path.join(DATA, "estado.json"), estado)
    print(json.dumps(estado, ensure_ascii=False, indent=1))
    return 0 if len(errores) < 4 else 1


if __name__ == "__main__":
    sys.exit(main())
