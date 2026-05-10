# Prop Firm Simulator

Simulador para evaluar estrategias de trading contra reglas de prop firms de futuros, con Monte Carlo, optimizer, editor de perfiles y modulo de bankroll/risk of ruin.

## Requisitos

- Node.js 20 o superior recomendado.
- npm.
- Git, si quieres clonar o contribuir.

## Instalacion

Clona el repositorio:

```bash
git clone https://github.com/Antoniojfl/propfirm-simulator.git
cd propfirm-simulator
```

Instala dependencias:

```bash
npm install
```

## Levantar el proyecto

Inicia el servidor local:

```bash
npm start
```

Abre la app en:

```text
http://localhost:3000
```

El servidor Express sirve la UI desde `public/index.html` y expone las APIs bajo `/api`.

## Comandos utiles

```bash
npm start
```

Levanta la app local en `http://localhost:3000`.

```bash
npm test
```

Ejecuta los tests unitarios del motor de simulacion, optimizer y bankroll.

```bash
npm run typecheck
```

Valida tipos TypeScript sin compilar archivos.

## Como usar la app

1. Selecciona un perfil de prop firm y una carpeta de estrategias.
2. Configura instrumentos y contratos por fase:
   - Evaluacion
   - Funded pre payout
   - Funded post payout
3. Elige Monte Carlo aleatorio o seed fijo.
4. Ejecuta la simulacion.
5. Revisa el ranking de estrategias.
6. Haz click en una estrategia para ver trazas trade a trade.

## Modulos principales

### Simulacion Monte Carlo

Calcula metricas por estrategia, incluyendo:

- pass rate
- payout rate
- expected value
- funded blow-up
- max consecutive losses
- trades/days to pass
- trazas representativas trade a trade

El modo `seeded` permite reproducir resultados con la misma seed.

### Profile Studio

Permite editar perfiles y reglas por fase:

- `Eval Rules`
- `Funded Rules`
- `Payout Rules`

Los perfiles soportan limites separados para:

- `maxMiniContracts`
- `maxMicroContracts`

### Optimizer

Busca combinaciones de instrumentos, contratos y scaling usando el motor Monte Carlo como dependencia. Devuelve ranking por score ajustado por riesgo.

### Bankroll Risk

Simula el negocio completo usando un bankroll operativo para comprar cuentas:

- risk of ruin
- stalled rate
- operating bankroll
- withdrawn profit
- total net worth
- net profit
- ROI
- curvas representativas
- eventos diarios

## Datos de entrada

Las estrategias viven en:

```text
strategies/
```

Actualmente se soportan archivos CSV exportados con columnas compatibles con el parser local. Las carpetas disponibles se detectan automaticamente desde `strategies/`.

Los perfiles de prop firms viven en:

```text
config/prop_firms/
```

Los defaults oficiales se guardan en:

```text
config/prop_firms/defaults/
```

## Estructura del proyecto

```text
public/
  index.html              UI principal

src/
  server.ts               API Express y jobs async
  simulationEngine.ts     Motor trade a trade por cuenta
  monteCarloEngine.ts     Monte Carlo por estrategia
  optimizer/              Modulo optimizer
  bankroll/               Modulo bankroll/risk of ruin
  profileStore.ts         Persistencia y validacion de perfiles
  tradeParser.ts          Parser CSV
  types.ts                Tipos compartidos

tests/
  *.test.ts               Tests unitarios
```

## APIs principales

- `GET /api/profiles`
- `PUT /api/profiles/:id`
- `POST /api/profiles/:id/duplicate`
- `POST /api/profiles/:id/restore`
- `GET /api/folders`
- `POST /api/simulate`
- `POST /api/optimize`
- `POST /api/bankroll/simulate`
- `GET /api/jobs/:id`
- `POST /api/jobs/:id/cancel`

Las corridas largas usan jobs async con progreso y cancelacion.

## Notas

- `node_modules/`, archivos temporales y `.rar` estan excluidos por `.gitignore`.
- Las reglas como HFT, hedging, news y duracion de trade se asumen cumplidas y no se modelan en v1.
- La curva principal de bankroll mide cash operativo; la ganancia retirada y total net worth se reportan por separado.
