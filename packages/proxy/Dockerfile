FROM node:20-alpine
WORKDIR /app
COPY . .
RUN corepack enable && pnpm install --frozen-lockfile && pnpm build
EXPOSE 8787
CMD ["node", "packages/cli/dist/index.js", "serve", "--policy", "policy.yaml"]
