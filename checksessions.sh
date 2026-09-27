#!/bin/bash
echo "=== Persisted Users (from profiles) ==="
for d in /docker/camofox-browser/data/.camofox/profiles/*/; do
  echo "UserId: $(basename "$d")"
  cat "$d/storage_state.json" 2>/dev/null | jq '.cookies | length' 2>/dev/null || echo "  (empty)"
done

echo -e "\n=== Active Runtime Sessions ==="
curl -s http://localhost:9377/health | jq '{activeSessions, activeTabs}'