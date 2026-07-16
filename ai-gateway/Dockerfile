# Альтернативный запуск Gateway в Docker (Ollama при этом всё равно нативная:
# в контейнере на macOS нет доступа к GPU/ANE, поэтому Ollama ставится через brew,
# а гейтвей ходит к ней на host.docker.internal).
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY main.py .
EXPOSE 8100
# В Docker OLLAMA_BASE_URL нужно переопределить на http://host.docker.internal:11434
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8100"]
