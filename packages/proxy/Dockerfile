FROM node:22-alpine
WORKDIR /app
COPY . .
RUN corepack enable && pnpm install --frozen-lockfile && pnpm build
USER node
EXPOSE 8787
CMD ["node", "packages/cli/dist/index.js", "serve", "--policy", "fixtures/policies/default.yaml", "--host", "0.0.0.0", "--decision-only"]
