#!/usr/bin/env bash
# Update the server to the latest code and show the collector log.
cd /opt/wa-selector && git pull -q --ff-only && cd selector-server && docker compose up -d --build && sleep 20 && docker compose ps && docker compose logs --tail 30
