# Plain Node image - this Actor is pure HTTP (Expedia's mobile GraphQL API), no browser needed.
FROM apify/actor-node:22 AS builder

COPY --chown=myuser:myuser package*.json ./

RUN npm install --include=dev --audit=false

COPY --chown=myuser:myuser . ./

RUN npm run build

# Create final image
FROM apify/actor-node:22

COPY --chown=myuser:myuser package*.json ./

# NOTE: no --omit=optional here. impit ships its TLS fingerprints as an optional
# native dependency; omitting optional deps installs fine but fails at runtime
# with a missing-binary import error.
RUN npm --quiet set progress=false \
    && npm install --omit=dev --audit=false \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" \
    && node --version \
    && echo "NPM version:" \
    && npm --version \
    && rm -r ~/.npm

COPY --from=builder --chown=myuser:myuser /usr/src/app/dist ./dist

COPY --chown=myuser:myuser . ./

CMD ["node", "dist/main.js"]
