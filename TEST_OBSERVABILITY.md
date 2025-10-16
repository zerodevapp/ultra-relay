# Observability Stack Testing

Automated end-to-end validation of the Alto observability stack.

## Quick Start

```bash
# Run with defaults (uses localhost:8545)
./test-observability.sh

# Or configure your own RPC/keys
export ALTO_RPC_URL=https://your-rpc-endpoint.com
export ALTO_ENTRYPOINTS=0x0000000071727De22E5E9d8BAf0edAc6f37da032
export ALTO_EXECUTOR_PRIVATE_KEYS=0x...
./test-observability.sh
```

## What It Tests

The script automatically validates:

1. **Build** - Alto compiles successfully
2. **Services** - All observability containers start and are healthy
   - Prometheus (metrics storage)
   - Tempo (trace storage)
   - Loki (log aggregation)
   - Alloy (log collector)
   - Grafana (visualization)
3. **Alto Startup** - Bundler starts with telemetry enabled
4. **Traffic Generation** - Sends test RPC requests
5. **Metrics** - Prometheus scraping Alto metrics endpoint
6. **Logs** - Loki collecting Alto logs via Alloy
7. **Traces** - Tempo receiving OpenTelemetry traces
8. **Grafana** - Datasources configured correctly

## Output

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Alto Observability Stack - Automated Validation
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[1/9] Building Alto...
✓ Build successful

[2/9] Starting observability stack...

[3/9] Waiting for services to be ready...
✓ Prometheus ready
✓ Tempo ready
✓ Loki ready
✓ Alloy ready
✓ Grafana ready

[4/9] Starting Alto with telemetry enabled...
✓ Alto started (PID: 12345)
✓ Alto ready

[5/9] Generating test traffic...
✓ Generated 5 test requests

[6/9] Validating metrics collection...
✓ Alto exposing metrics
✓ Prometheus scraping Alto metrics

[7/9] Validating logs collection...
✓ Loki collecting logs (3 streams found)

[8/9] Validating traces collection...
✓ Tempo collecting traces (5 traces found)
✓ Traces contain Alto service spans
✓ Trace contains 12 spans

[9/9] Validating Grafana datasources...
✓ Prometheus datasource configured
✓ Tempo datasource configured
✓ Loki datasource configured

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Validation Results
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🎉 All checks passed!

Access the observability stack:
  • Grafana:    http://localhost:3003 (admin/admin)
  • Prometheus: http://localhost:9090
  • Tempo:      http://localhost:3200
  • Loki:       http://localhost:3100
  • Alto:       http://localhost:3000

Stack will remain running. Press Ctrl+C to stop and cleanup.
```

## Cleanup

Press `Ctrl+C` to stop everything. The script automatically:
- Stops all Docker containers
- Removes volumes
- Kills Alto process

## Manual Testing

If you prefer to test manually:

```bash
# Start observability stack
docker-compose -f docker-compose.observability.yml up -d

# Start Alto with telemetry
ALTO_ENABLE_TELEMETRY=true \
ALTO_OTLP_ENDPOINT=http://localhost:4318/v1/traces \
ALTO_RPC_URL=https://... \
pnpm start

# Access Grafana
open http://localhost:3003  # admin/admin

# Cleanup
docker-compose -f docker-compose.observability.yml down -v
```

## Troubleshooting

**Script fails on service health checks:**
```bash
# Check container logs
docker-compose -f docker-compose.observability.yml logs

# Check specific service
docker-compose -f docker-compose.observability.yml logs tempo
```

**No traces appearing:**
```bash
# Check Alto is sending traces
cat /tmp/alto.log | grep -i otel

# Verify Tempo receiving data
curl http://localhost:3200/api/search?limit=10
```

**No logs appearing:**
```bash
# Check Alloy is discovering containers
curl http://localhost:12345/api/v0/targets

# Check Loki query
curl -G "http://localhost:3100/loki/api/v1/query" \
  --data-urlencode 'query={logging="alloy"}'
```

## Requirements

- Docker and Docker Compose
- Node.js and pnpm
- jq (for JSON parsing)
- curl
- Valid RPC URL in `ALTO_RPC_URL`
