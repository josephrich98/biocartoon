# The hosted MCP server: `biocartoon mcp --http` in a container, for assistants that reach only remote
# servers (ChatGPT, claude.ai). Deployed on Cloudflare Containers by worker/wrangler.mcp.jsonc, but it
# runs on any container host: it listens on $PORT and needs nothing but outbound HTTPS.
#   docker build -t biocartoon-mcp catalog && docker run -p 8080:8080 biocartoon-mcp
FROM rust:1-bookworm AS build
WORKDIR /src
COPY . .
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
