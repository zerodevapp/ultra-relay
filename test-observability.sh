#!/bin/bash
set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  Alto Observability Stack - Automated Validation${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"

FAILED=0

# Cleanup function
cleanup() {
    echo -e "\n${YELLOW}🧹 Cleaning up...${NC}"
    docker-compose -f docker-compose.observability.yml down -v > /dev/null 2>&1 || true
    if [ ! -z "$ALTO_PID" ]; then
        kill $ALTO_PID > /dev/null 2>&1 || true
    fi
}

trap cleanup EXIT

# Check if RPC URL is set
if [ -z "$ALTO_RPC_URL" ]; then
    echo -e "${RED}❌ ALTO_RPC_URL environment variable not set${NC}"
    echo -e "${YELLOW}   Export a valid RPC URL: export ALTO_RPC_URL=https://...${NC}"
    exit 1
fi

# Step 1: Build Alto
echo -e "${BLUE}[1/9]${NC} Building Alto..."
if pnpm build > /tmp/alto-build.log 2>&1; then
    echo -e "${GREEN}✓${NC} Build successful"
else
    echo -e "${RED}✗${NC} Build failed"
    cat /tmp/alto-build.log
    exit 1
fi

# Step 2: Start Observability Stack
echo -e "\n${BLUE}[2/9]${NC} Starting observability stack..."
docker-compose -f docker-compose.observability.yml up -d

# Step 3: Wait for services to be healthy
echo -e "\n${BLUE}[3/9]${NC} Waiting for services to be ready..."

wait_for_service() {
    local name=$1
    local url=$2
    local max_attempts=30
    local attempt=1

    while [ $attempt -le $max_attempts ]; do
        if curl -sf "$url" > /dev/null 2>&1; then
            echo -e "${GREEN}✓${NC} $name ready"
            return 0
        fi
        sleep 2
        attempt=$((attempt + 1))
    done

    echo -e "${RED}✗${NC} $name failed to start"
    FAILED=$((FAILED + 1))
    return 1
}

wait_for_service "Prometheus" "http://localhost:9090/-/healthy"
wait_for_service "Tempo" "http://localhost:3200/ready"
wait_for_service "Loki" "http://localhost:3100/ready"
wait_for_service "Alloy" "http://localhost:12345/-/ready"
wait_for_service "Grafana" "http://localhost:3003/api/health"

# Step 4: Start Alto with telemetry
echo -e "\n${BLUE}[4/9]${NC} Starting Alto with telemetry enabled..."

ALTO_ENABLE_TELEMETRY=true \
ALTO_OTLP_ENDPOINT=http://localhost:4318/v1/traces \
ALTO_RPC_URL="$ALTO_RPC_URL" \
ALTO_PORT=3000 \
ALTO_JSON=true \
pnpm start > /tmp/alto.log 2>&1 &

ALTO_PID=$!

# Wait for Alto to start
sleep 5

if kill -0 $ALTO_PID 2>/dev/null; then
    echo -e "${GREEN}✓${NC} Alto started (PID: $ALTO_PID)"
else
    echo -e "${RED}✗${NC} Alto failed to start"
    cat /tmp/alto.log
    exit 1
fi

# Wait for Alto to be responsive
wait_for_service "Alto" "http://localhost:3000/metrics"

# Step 5: Generate test traffic
echo -e "\n${BLUE}[5/9]${NC} Generating test traffic..."

for i in {1..5}; do
    curl -sf -X POST http://localhost:3000 \
        -H "Content-Type: application/json" \
        -d '{
            "jsonrpc": "2.0",
            "id": 1,
            "method": "eth_supportedEntryPoints",
            "params": []
        }' > /dev/null
    sleep 1
done

echo -e "${GREEN}✓${NC} Generated 5 test requests"

# Give telemetry time to propagate
echo -e "${YELLOW}⏳${NC} Waiting 10s for telemetry to propagate..."
sleep 10

# Step 6: Validate Metrics
echo -e "\n${BLUE}[6/9]${NC} Validating metrics collection..."

METRICS=$(curl -sf http://localhost:3000/metrics)

if echo "$METRICS" | grep -q "process_cpu_seconds_total"; then
    echo -e "${GREEN}✓${NC} Alto exposing metrics"
else
    echo -e "${RED}✗${NC} Alto not exposing metrics"
    FAILED=$((FAILED + 1))
fi

PROM_TARGETS=$(curl -sf http://localhost:9090/api/v1/targets | jq -r '.data.activeTargets[] | select(.labels.job == "alto-bundler") | .health')

if [ "$PROM_TARGETS" = "up" ]; then
    echo -e "${GREEN}✓${NC} Prometheus scraping Alto metrics"
else
    echo -e "${RED}✗${NC} Prometheus not scraping Alto (target: $PROM_TARGETS)"
    FAILED=$((FAILED + 1))
fi

# Step 7: Validate Logs
echo -e "\n${BLUE}[7/9]${NC} Validating logs collection..."

LOKI_QUERY=$(curl -sf -G "http://localhost:3100/loki/api/v1/query" \
    --data-urlencode 'query={logging="alloy"}' \
    --data-urlencode "time=$(date +%s)000000000" | jq -r '.data.result | length')

if [ "$LOKI_QUERY" -gt 0 ]; then
    echo -e "${GREEN}✓${NC} Loki collecting logs ($LOKI_QUERY streams found)"
else
    echo -e "${RED}✗${NC} Loki not collecting logs"
    FAILED=$((FAILED + 1))
fi

# Step 8: Validate Traces
echo -e "\n${BLUE}[8/9]${NC} Validating traces collection..."

TEMPO_TRACES=$(curl -sf "http://localhost:3200/api/search?limit=100" | jq -r '.traces | length')

if [ "$TEMPO_TRACES" -gt 0 ]; then
    echo -e "${GREEN}✓${NC} Tempo collecting traces ($TEMPO_TRACES traces found)"
else
    echo -e "${RED}✗${NC} Tempo not collecting traces"
    FAILED=$((FAILED + 1))
fi

# Validate trace details
TRACE_ID=$(curl -sf "http://localhost:3200/api/search?limit=1" | jq -r '.traces[0].traceID')

if [ ! -z "$TRACE_ID" ] && [ "$TRACE_ID" != "null" ]; then
    TRACE_DETAILS=$(curl -sf "http://localhost:3200/api/traces/$TRACE_ID")

    if echo "$TRACE_DETAILS" | jq -e '.batches[0].resource.attributes[] | select(.key == "service.name" and .value.stringValue == "alto")' > /dev/null; then
        echo -e "${GREEN}✓${NC} Traces contain Alto service spans"
    else
        echo -e "${YELLOW}⚠${NC} Traces found but service name not verified"
    fi

    SPAN_COUNT=$(echo "$TRACE_DETAILS" | jq -r '.batches[0].scopeSpans[0].spans | length')
    if [ "$SPAN_COUNT" -gt 0 ]; then
        echo -e "${GREEN}✓${NC} Trace contains $SPAN_COUNT spans"
    fi
fi

# Step 9: Validate Grafana Datasources
echo -e "\n${BLUE}[9/9]${NC} Validating Grafana datasources..."

DATASOURCES=$(curl -sf -u admin:admin http://localhost:3003/api/datasources | jq -r '.[].name')

check_datasource() {
    local name=$1
    if echo "$DATASOURCES" | grep -q "$name"; then
        echo -e "${GREEN}✓${NC} $name datasource configured"
    else
        echo -e "${RED}✗${NC} $name datasource missing"
        FAILED=$((FAILED + 1))
    fi
}

check_datasource "Prometheus"
check_datasource "Tempo"
check_datasource "Loki"

# Final Report
echo -e "\n${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  Validation Results${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"

if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}🎉 All checks passed!${NC}\n"
    echo -e "Access the observability stack:"
    echo -e "  • Grafana:    ${BLUE}http://localhost:3003${NC} (admin/admin)"
    echo -e "  • Prometheus: ${BLUE}http://localhost:9090${NC}"
    echo -e "  • Tempo:      ${BLUE}http://localhost:3200${NC}"
    echo -e "  • Loki:       ${BLUE}http://localhost:3100${NC}"
    echo -e "  • Alto:       ${BLUE}http://localhost:3000${NC}\n"
    echo -e "${YELLOW}Stack will remain running. Press Ctrl+C to stop and cleanup.${NC}\n"

    # Keep running
    wait $ALTO_PID
    exit 0
else
    echo -e "${RED}❌ $FAILED check(s) failed${NC}\n"
    echo -e "${YELLOW}Logs available at:${NC}"
    echo -e "  • Alto:  /tmp/alto.log"
    echo -e "  • Build: /tmp/alto-build.log\n"
    exit 1
fi
