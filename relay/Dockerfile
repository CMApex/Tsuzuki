FROM rust:1-slim AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --locked

FROM debian:stable-slim
RUN useradd --system --uid 10001 tsuzuki && mkdir /data && chown tsuzuki /data
COPY --from=build /src/target/release/tsuzuki-relay /usr/local/bin/tsuzuki-relay
USER tsuzuki
ENV TSUZUKI_BIND=0.0.0.0:8787 TSUZUKI_DATA=/data
VOLUME /data
EXPOSE 8787
ENTRYPOINT ["tsuzuki-relay"]
