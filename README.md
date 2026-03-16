# GaiaLog

**Immutable environmental data on the BSV blockchain.**

GaiaLog ingests real-time environmental readings from dozens of public data sources worldwide and records them as OP_RETURN transactions on the Bitcoin SV blockchain, creating a permanent, tamper-proof archive of Earth observation data.

## Architecture

```
Data Providers  -->  Worker Threads  -->  Queue  -->  BSV Blockchain
  (APIs)             (collectors)        (FIFO)       (OP_RETURN TXs)
                                           |
                                      Overlay Service
                                       (UTXO mgmt)
```

- **Next.js** frontend + API routes (hosted on Vercel)
- **VPS worker processes** managed by PM2 (data collection + blockchain writes)
- **Overlay Service** for UTXO tracking and transaction admission
- **Supabase PostgreSQL** for metadata, explorer index, and cursor persistence
- **BSV SDK** (`@bsv/sdk`) for transaction construction and broadcast

## Data Sources

| Provider | Data Type | Stations | Update Cadence |
|----------|-----------|----------|----------------|
| WAQI | Air Quality | 14,000+ | 15 min |
| NOAA CO-OPS | Water Levels | 3,000+ | 6 min |
| NOAA NDBC | Ocean Buoys | 1,000+ | 5 min |
| Sensor.Community | Air Quality (citizen) | 35,000+ | 5 min |
| USGS Earthquakes | Seismic Activity | Global | 5 min |
| EMSC | Seismic (EU) | Global | Real-time (WebSocket) |
| GeoNet NZ | Seismic + Volcanic | 700+ | 5 min |
| NOAA DSCOVR/ACE | Space Weather | L1 satellite | 1 min |
| USGS Geomagnetism | Magnetic Field | 14 observatories | 1 min |
| USGS Volcanoes | Volcanic Alerts | 170+ | 10 min |
| IGRA v2 | Upper Atmosphere | 2,700+ | 12 hours |
| OpenWeatherMap | Advanced Metrics | Configurable | 30 min |

See [`earth_apis_bonus.md`](earth_apis_bonus.md) for the full API reference.

## Quick Start

### Prerequisites

- Node.js 20+
- BSV wallet private keys (WIF format)
- Supabase project (free tier works)
- WAQI API key (free at [aqicn.org/data-platform/token](https://aqicn.org/data-platform/token))

### 1. Clone and install

```bash
git clone https://github.com/your-org/GaiaLog.git
cd GaiaLog
npm install
```

### 2. Configure environment

```bash
cp env.template .env
# Edit .env with your keys — see env.template for all options
```

Required variables:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
PGHOST=aws-0-eu-west-1.pooler.supabase.com
PGPORT=5432
PGDATABASE=postgres
PGUSER=postgres.your-project-ref
PGPASSWORD=your-db-password

BSV_PRIVATE_KEY_1=your-wif-key-1
BSV_PRIVATE_KEY_2=your-wif-key-2
BSV_PRIVATE_KEY_3=your-wif-key-3

WAQI_API_KEY=your-waqi-token
```

### 3. Run database migrations

```bash
npm run db:migrate
```

### 4. Development

```bash
# Terminal 1: Next.js frontend
npm run dev

# Terminal 2: Overlay service
npm run overlay

# Terminal 3: Worker processes
npm run workers
```

### 5. Production (VPS)

```bash
npm run build
pm2 start ecosystem.config.cjs
pm2 save
```

See [`DEPLOYMENT_QUICKSTART.md`](DEPLOYMENT_QUICKSTART.md) and [`VERCEL_VPS_SPLIT_DEPLOYMENT.md`](VERCEL_VPS_SPLIT_DEPLOYMENT.md) for detailed deployment guides.

## Project Structure

```
app/                    Next.js app directory (pages + API routes)
lib/                    Core library
  blockchain.ts         BSV transaction construction + broadcast
  worker-threads.ts     Data provider worker implementations
  data-collector.ts     API data collection functions
  worker-queue.ts       FIFO queue with parallel processing
  overlay-server.ts     Local overlay HTTP server
  overlay-service.ts    UTXO admission + tracking
  provider-registry.ts  Provider configuration + rollout gates
  stream-registry.ts    Dataset descriptors + family mappings
  rollout-controls.ts   Phased provider enablement
db/migrations/          SQL migration files
scripts/                CLI tools (migrate, split-utxos, etc.)
ecosystem.config.cjs    PM2 process configuration
```

## Generating Wallet Keys

```bash
node -e "const { PrivateKey } = require('@bsv/sdk'); console.log(PrivateKey.fromRandom().toWif())"
```

Run this three times and set the results as `BSV_PRIVATE_KEY_1`, `_2`, and `_3` in your `.env`.

## Explorer

The `/explorer` page provides a searchable index of all blockchain-recorded environmental readings, with filtering by location, data type, and time range.

## Rollout Gates

Providers are enabled progressively via rollout gates (`gate_a` through `gate_d`) to control load during scaling. Set `GAIALOG_ROLLOUT_GATE=gate_b` (or higher) in your `.env` to enable more providers. The default is `gate_b`.

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/new-provider`)
3. Commit your changes
4. Push to the branch and open a Pull Request

## Licence

[MIT](LICENSE)
