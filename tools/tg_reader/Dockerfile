FROM python:3.12-slim
WORKDIR /app
RUN pip install --no-cache-dir telethon==1.45.0 httpx==0.28.1
COPY reader.py .
ENTRYPOINT ["python", "reader.py"]
