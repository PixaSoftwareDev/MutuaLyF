FROM python:3.11-slim

WORKDIR /srv
RUN pip install --no-cache-dir "fastapi==0.111.0" "uvicorn[standard]==0.30.1" "PyJWT==2.8.0"

COPY app.py /srv/app.py

EXPOSE 4003
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "4003"]
