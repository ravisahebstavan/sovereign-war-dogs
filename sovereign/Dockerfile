FROM rust:1.76-slim as builder
WORKDIR /usr/src/sovereign
COPY . .
RUN apt-get update && apt-get install -y pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /usr/src/sovereign/target/release/sovereign-core /usr/local/bin/sovereign-core
EXPOSE 9001
CMD ["sovereign-core"]
