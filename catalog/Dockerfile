# Optional self-hosted Rust MCP server: `biocartoon mcp --http` in a container, for assistants
# that reach remote servers. The public endpoint now uses the free Worker in worker/src/mcp.ts.
# This image runs on other container hosts: it listens on $PORT and needs outbound HTTPS.
#   docker build -t biocartoon-mcp catalog && docker run -p 8080:8080 biocartoon-mcp
FROM node:24-bookworm-slim AS ui
WORKDIR /ui
COPY ui/package.json ui/package-lock.json ./
RUN npm ci --ignore-scripts
COPY ui/ ./
RUN npm run typecheck && npm run build

FROM rust:1-bookworm AS build
WORKDIR /src
COPY . .
COPY --from=ui /ui/dist/gallery.html ui/dist/gallery.html
RUN cargo build --release --locked --bin biocartoon

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --home-dir /data biocartoon
COPY --from=build /src/target/release/biocartoon /usr/local/bin/biocartoon
USER biocartoon
# The catalog is downloaded into $HOME/.local/share/biocartoon on the first request, and kept current.
ENV HOME=/data PORT=8080
EXPOSE 8080
CMD ["biocartoon", "mcp", "--http"]
