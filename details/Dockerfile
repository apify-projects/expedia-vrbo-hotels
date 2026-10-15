# Build stage: compile TypeScript to dist/
FROM apify/actor-node:22 AS builder

COPY package*.json ./
RUN npm install --include=dev --audit=false

COPY . ./
RUN npm run build

# Runtime stage: production deps + compiled output only
FROM apify/actor-node:22

COPY package*.json ./
# NOTE: do NOT pass --omit=optional — impit ships its prebuilt native binding
# (@impit/linux-*) as an optional dependency; omitting it makes the actor crash
# on startup with "impit couldn't load native bindings".
RUN npm --quiet set progress=false \
    && npm install --omit=dev --audit=false \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" \
    && node --version \
    && echo "NPM version:" \
    && npm --version

COPY --from=builder /usr/src/app/dist ./dist
COPY . ./

CMD ["npm", "run", "start:prod", "--silent"]
