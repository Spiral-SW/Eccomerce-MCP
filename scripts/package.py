"""Gera pacotes portáteis sem credenciais. Publica só arquivos já verificados."""
from pathlib import Path
import json
import os
import sys
import zipfile

project = Path(__file__).resolve().parents[1]
destination = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else project.parent
destination.mkdir(parents=True, exist_ok=True)
sources = destination / "ollyx-mcp.zip"
extension = destination / "ollyx-mcp.mcpb"

def walk_files(directory, excluded=()):
    for parent, dirs, files in os.walk(directory):
        dirs[:] = sorted(d for d in dirs if d not in excluded)
        for name in sorted(files):
            yield Path(parent) / name

def verify_publish(temp, final):
    with zipfile.ZipFile(temp) as z:
        names = z.namelist()
        if any("/secrets/" in x or x.startswith(("cache/", "exports/", "ollyx-mcp/cache/", "ollyx-mcp/exports/")) or x.split("/")[-1].startswith(".env") and not x.endswith(".env.example") or x.startswith((".vercel/", "ollyx-mcp/.vercel/")) for x in names):
            raise RuntimeError("Arquivo privado indevido no pacote.")
        if z.testzip() is not None:
            raise RuntimeError("Pacote corrompido.")
    os.replace(temp, final)
    print(final.name + ": " + str(final.stat().st_size) + " bytes", flush=True)

temp_sources = sources.with_suffix(".zip.pending")
with zipfile.ZipFile(temp_sources, "w", zipfile.ZIP_DEFLATED, compresslevel=1) as z:
    for p in walk_files(project, {"node_modules", "secrets", ".git", ".vercel", "config", "dist", "release", "cache", "exports", "logs"}):
        if (p.name.startswith(".env") and p.name != ".env.example") or p.suffix in {".log", ".jsonl"} or p.name.startswith("validation-"):
            continue
        z.write(p, Path("ollyx-mcp") / p.relative_to(project))
verify_publish(temp_sources, sources)

temp_extension = extension.with_suffix(".mcpb.pending")
with zipfile.ZipFile(temp_extension, "w", zipfile.ZIP_DEFLATED, compresslevel=1) as z:
    for name in ["manifest.json", "package.json", "package-lock.json", "README.md", "CLAUDE-DESKTOP.md", ".env.example"]:
        z.write(project / name, name)
    count = 0
    for directory in ["src", "catalog", "node_modules"]:
        for p in walk_files(project / directory):
            if p.suffix in {".node", ".exe", ".dll"}:
                raise RuntimeError("Dependência nativa encontrada; gere um pacote específico por plataforma.")
            if p.name == ".env" or p.suffix == ".map" or p.name.endswith(".d.ts"):
                continue
            z.write(p, p.relative_to(project))
            count += 1
            if count % 1000 == 0:
                print("Bibliotecas incluídas: " + str(count) + " arquivos.", flush=True)
verify_publish(temp_extension, extension)
