FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    CHROMA_PATH=/data/chroma

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Bake Chroma's default embedding model into the image so the first question isn't
# stalled by an ~80 MB download.
RUN python -c "from chromadb.utils.embedding_functions import DefaultEmbeddingFunction as E; E()(['warmup'])"

COPY app ./app

RUN useradd --create-home mayami && mkdir -p /data && chown -R mayami /data && \
    cp -r /root/.cache /home/mayami/.cache && chown -R mayami /home/mayami/.cache
USER mayami

EXPOSE 8000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=3s CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')"
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--ws-ping-interval", "20"]
