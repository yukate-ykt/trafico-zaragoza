# Tráfico Zaragoza en directo

Web gratuita que muestra el tráfico de Zaragoza en tiempo real usando solo datos abiertos y oficiales, y que guarda un histórico para detectar patrones (horas y días con más incidencias, puntos donde se repiten).

## Capas

| Capa | Fuente | Frecuencia |
|---|---|---|
| Tráfico urbano: tiempos de recorrido (17 paneles) | Ayuntamiento de Zaragoza, `tiempos-recorrido` | En directo, cada 2 min |
| Incidencias en accesos y rondas (Z-40, A-2, A-23, A-68, AP-68, N-232, N-330) | DGT, Punto de Acceso Nacional, DATEX II v3.7 | Cada 10 min (recolector) |
| Cámaras DGT con imagen en directo | DGT, Punto de Acceso Nacional (inventario) + `etraffic.dgt.es` | Imagen cada 60 s |
| Cortes de tráfico y afecciones en la ciudad | Ayuntamiento, `via-publica/incidencia` | En directo, cada 5 min |
| Tranvía: próximas llegadas en las 50 paradas | Ayuntamiento, `parada-tranvia` | En directo, cada minuto |
| Autobús: llegadas en los 1.271 postes | Ayuntamiento, `poste-autobus` | Al pulsar la parada |

No están en abierto hoy: el estado de fluidez calle a calle del Ayuntamiento, las imágenes de las cámaras municipales y la posición GPS de los autobuses.

## Cómo funciona

- `docs/` es la web (HTML + JavaScript, sin servidor). Se publica gratis con GitHub Pages.
- `collector/collect.py` es el recolector. GitHub Actions lo ejecuta cada 10 minutos (`.github/workflows/recolector.yml`): descarga la DGT (que no deja leer sus datos directamente desde el navegador), guarda una foto en `docs/data/historico/AAAA-MM-DD.jsonl` y recalcula `docs/data/patrones.json`.
- Para probarlo en local: `python3 collector/collect.py` y después `python3 -m http.server -d docs`.

## Publicar

1. Subir esta carpeta a un repositorio de GitHub.
2. Settings → Pages → Source: «Deploy from a branch», rama `main`, carpeta `/docs`.
3. Settings → Actions → General → Workflow permissions: «Read and write permissions».
4. Actions → «Recolector de datos de tráfico» → «Run workflow» para la primera ejecución.
