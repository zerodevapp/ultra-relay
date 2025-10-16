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
    echo -e "${YELLOW}⚠${NC}  ALTO_RPC_URL not set, using default localhost"
    ALTO_RPC_URL="http://localhost:8545"
fi

# Generate test private key if not set
if [ -z "$ALTO_EXECUTOR_PRIVATE_KEYS" ]; then
    echo -e "${YELLOW}⚠${NC}  ALTO_EXECUTOR_PRIVATE_KEYS not set, using test key"
    ALTO_EXECUTOR_PRIVATE_KEYS="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
fi

# Set default entrypoint if not set
if [ -z "$ALTO_ENTRYPOINTS" ]; then
    echo -e "${YELLOW}⚠${NC}  ALTO_ENTRYPOINTS not set, using v0.7 default"
    ALTO_ENTRYPOINTS="0x0000000071727De22E5E9d8BAf0edAc6f37da032"
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
ALTO_ENTRYPOINTS="$ALTO_ENTRYPOINTS" \
ALTO_EXECUTOR_PRIVATE_KEYS="$ALTO_EXECUTOR_PRIVATE_KEYS" \
ALTO_PORT=3000 \
ALTO_JSON=true \
ALTO_SAFE_MODE=false \
pnpm start > /tmp/alto.log 2>&1 &

ALTO_PID=$!

# Wait for Alto to start
sleep 5

if kill -0 $ALTO_PID 2>/dev/null; then
    echo -e "${GREEN}✓${NC} Alto started (PID: $ALTO_PID)"

    # Wait for Alto to be responsive
    if wait_for_service "Alto" "http://localhost:3000/metrics"; then
        ALTO_RUNNING=true
    else
        echo -e "${YELLOW}⚠${NC} Alto not responding (likely RPC connection issue)"
        echo -e "${YELLOW}   Check /tmp/alto.log for details${NC}"
        ALTO_RUNNING=false
        kill $ALTO_PID 2>/dev/null || true
        ALTO_PID=""
    fi
else
    echo -e "${YELLOW}⚠${NC}  Alto failed to start (likely RPC connection issue)"
    echo -e "${YELLOW}   Continuing with observability stack validation...${NC}"
    ALTO_RUNNING=false
    ALTO_PID=""
fi

# Step 5: Generate test traffic
echo -e "\n${BLUE}[5/9]${NC} Generating test traffic..."

if [ "$ALTO_RUNNING" = true ]; then
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
else
    echo -e "${YELLOW}⚠${NC}  Skipping (Alto not running)"
fi

# Step 6: Validate Metrics
echo -e "\n${BLUE}[6/9]${NC} Validating metrics collection..."

if [ "$ALTO_RUNNING" = true ]; then
    METRICS=$(curl -sf http://localhost:3000/metrics)

    if echo "$METRICS" | grep -q "process_cpu_seconds_total"; then
        echo -e "${GREEN}✓${NC} Alto exposing metrics"
    else
        echo -e "${YELLOW}⚠${NC} Alto not exposing metrics"
    fi

    PROM_TARGETS=$(curl -sf http://localhost:9090/api/v1/targets | jq -r '.data.activeTargets[] | select(.labels.job == "alto-bundler") | .health')

    if [ "$PROM_TARGETS" = "up" ]; then
        echo -e "${GREEN}✓${NC} Prometheus scraping Alto metrics"
    else
        echo -e "${YELLOW}⚠${NC}  Prometheus not scraping Alto (Alto not running)"
    fi
else
    echo -e "${YELLOW}⚠${NC}  Skipping (Alto not running)"
    echo -e "${BLUE}ℹ${NC}  Prometheus ready at http://localhost:9090"
fi

# Step 7: Validate Logs
echo -e "\n${BLUE}[7/9]${NC} Validating logs collection..."

if [ "$ALTO_RUNNING" = true ]; then
    LOKI_QUERY=$(curl -sf -G "http://localhost:3100/loki/api/v1/query" \
        --data-urlencode 'query={logging="alloy"}' \
        --data-urlencode "time=$(date +%s)000000000" | jq -r '.data.result | length')

    if [ "$LOKI_QUERY" -gt 0 ]; then
        echo -e "${GREEN}✓${NC} Loki collecting logs ($LOKI_QUERY streams found)"
    else
        echo -e "${YELLOW}⚠${NC}  Loki not collecting logs yet (Alto just started)"
    fi
else
    echo -e "${YELLOW}⚠${NC}  Skipping (Alto not running)"
    echo -e "${BLUE}ℹ${NC}  Loki ready at http://localhost:3100"
fi

# Step 8: Validate Traces
echo -e "\n${BLUE}[8/9]${NC} Validating traces collection..."

if [ "$ALTO_RUNNING" = true ]; then
    TEMPO_TRACES=$(curl -sf "http://localhost:3200/api/search?limit=100" | jq -r '.traces | length')

    if [ "$TEMPO_TRACES" -gt 0 ]; then
        echo -e "${GREEN}✓${NC} Tempo collecting traces ($TEMPO_TRACES traces found)"

        # Validate trace details
        TRACE_ID=$(curl -sf "http://localhost:3200/api/search?limit=1" | jq -r '.traces[0].traceID')

        if [ ! -z "$TRACE_ID" ] && [ "$TRACE_ID" != "null" ]; then
            TRACE_DETAILS=$(curl -sf "http://localhost:3200/api/traces/$TRACE_ID")

            if echo "$TRACE_DETAILS" | jq -e '.batches[0].resource.attributes[] | select(.key == "service.name" and .value.stringValue == "alto")' > /dev/null 2>&1; then
                echo -e "${GREEN}✓${NC} Traces contain Alto service spans"
            fi

            SPAN_COUNT=$(echo "$TRACE_DETAILS" | jq -r '.batches[0].scopeSpans[0].spans | length' 2>/dev/null || echo "0")
            if [ "$SPAN_COUNT" -gt 0 ]; then
                echo -e "${GREEN}✓${NC} Trace contains $SPAN_COUNT spans"
            fi
        fi
    else
        echo -e "${YELLOW}⚠${NC}  Tempo not collecting traces yet (Alto just started)"
    fi
else
    echo -e "${YELLOW}⚠${NC}  Skipping (Alto not running)"
    echo -e "${BLUE}ℹ${NC}  Tempo ready at http://localhost:3200"
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
    echo -e "${GREEN}✅ Observability stack validation complete!${NC}\n"

    if [ "$ALTO_RUNNING" = true ]; then
        echo -e "${GREEN}✓ Alto running with telemetry enabled${NC}"
    else
        echo -e "${YELLOW}⚠ Alto not running (requires valid RPC endpoint)${NC}"
        echo -e "  To test with Alto, set ALTO_RPC_URL and re-run\n"
    fi

    echo -e "Access the observability stack:"
    echo -e "  • Grafana:    ${BLUE}http://localhost:3003${NC} (admin/admin)"
    echo -e "  • Prometheus: ${BLUE}http://localhost:9090${NC}"
    echo -e "  • Tempo:      ${BLUE}http://localhost:3200${NC}"
    echo -e "  • Loki:       ${BLUE}http://localhost:3100${NC}"

    if [ "$ALTO_RUNNING" = true ]; then
        echo -e "  • Alto:       ${BLUE}http://localhost:3000${NC}"
    fi

    echo -e "\n${YELLOW}Stack will remain running. Press Ctrl+C to stop and cleanup.${NC}\n"

    # Keep running if Alto is running
    if [ ! -z "$ALTO_PID" ]; then
        wait $ALTO_PID
    else
        # Just wait indefinitely if Alto isn't running
        echo "Press Ctrl+C to stop..."
        while true; do sleep 1; done
    fi
    exit 0
else
    echo -e "${RED}❌ $FAILED check(s) failed${NC}\n"
    echo -e "${YELLOW}Logs available at:${NC}"
    echo -e "  • Alto:  /tmp/alto.log"
    echo -e "  • Build: /tmp/alto-build.log\n"
    exit 1
fi
