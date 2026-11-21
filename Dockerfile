FROM node:24-bookworm-slim AS frontend
WORKDIR /source/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS backend
WORKDIR /source
COPY api/ ./
RUN dotnet restore --locked-mode
COPY --from=frontend /source/api/wwwroot ./wwwroot
RUN dotnet publish --no-restore -c Release -o /app

FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /app
COPY --from=backend /app .
USER $APP_UID
ENTRYPOINT ["dotnet", "DepotBooking.dll"]
