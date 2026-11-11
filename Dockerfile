FROM node:24-bookworm-slim
WORKDIR /app
COPY --chown=node:node dist/ ./dist/
COPY --chown=node:node public/ ./public/
COPY --chown=node:node package.json ./
RUN mkdir -p /app/data && chown node:node /app/data
USER node
ENV HOST=0.0.0.0 PORT=8787 TWC_DATA_DIR=/app/data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
