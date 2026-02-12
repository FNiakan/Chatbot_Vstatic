# Chatbot PDF (Frontend statique + API FastAPI)

Ce projet est un chatbot documentaire qui répond aux questions **uniquement à partir de fichiers PDF**.

Le backend utilise :
- `FastAPI` pour l'API
- `LangChain + Chroma` pour l'indexation vectorielle (RAG)
- `Azure OpenAI` pour les embeddings et la génération de réponses

Le frontend principal est une interface **statique** servie par FastAPI.

## Structure du projet

- `app.py` : API FastAPI + service du frontend statique
- `tool.py` : logique RAG (indexation PDF, recherche, Chroma)
- `context.py` : prompts/instructions agent
- `static/chatbot/` : frontend statique (`index.html`, `app.js`, `styles.css`)
- `Database/` : **dossier source des PDF à indexer**
- `chroma_db/` : base vectorielle générée automatiquement
- `runtime/` : fichiers runtime (sessions SQLite)

## Où mettre les PDF

Placez vos documents PDF dans :

`Database/`

Exemples :
- `Database/guide-procedure.pdf`
- `Database/RH/politique-conges.pdf`

Le code scanne récursivement `Database/**/*.pdf`.

## Fonctionnement

1. Au démarrage, l'application vérifie si l'index Chroma est à jour.
2. Si nécessaire, elle réindexe les PDF de `Database/`.
3. L'utilisateur envoie une question via l'interface web.
4. Le système récupère les passages pertinents dans les PDF.
5. Le modèle génère une réponse basée sur ces passages.

Si le sujet n'existe pas dans les PDF indexés, l'assistant renvoie un message de non-disponibilité.

## Variables d'environnement (`.env`)

Variables minimales côté chat :
- `AZURE_OPENAI_ENDPOINT`
- `AZURE_OPENAI_API_KEY`

Variables embeddings (indexation RAG) :
- `AZURE_OPENAI_EMBED_ENDPOINT`
- `AZURE_OPENAI_EMBED_API_KEY`
- `AZURE_OPENAI_DEPLOYMENT_EMBED`

Variables optionnelles :
- `AZURE_OPENAI_API_VERSION` (défaut : `2025-01-01-preview`)
- `AZURE_OPENAI_DEPLOYMENT_CHAT` (défaut : `gpt-5-mini`)
- `AZURE_OPENAI_DEPLOYMENT_QA` (par défaut identique au chat)
- `AZURE_OPENAI_EMBED_API_VERSION`
- `ALLOWED_ORIGINS`

## Lancer en local

1. Installer les dépendances (exemple avec `uv` ou `pip`).
2. Vérifier le fichier `.env`.
3. Démarrer l'API :

```bash
uvicorn app:app --host 0.0.0.0 --port 8000 --reload
```

Puis ouvrir :

`http://localhost:8000`

## Endpoints utiles

- `GET /` : frontend statique du chatbot
- `GET /api/health` : état de l'API et de l'indexation au démarrage
- `GET /api/kb` : nombre de PDF et date de dernière mise à jour
- `POST /api/reindex` : force une réindexation
- `POST /api/chat` : envoi d'un message utilisateur

## Frontend statique

Le frontend utilisé est dans :

`static/chatbot/`

Fichiers principaux :
- `static/chatbot/index.html`
- `static/chatbot/app.js`
- `static/chatbot/styles.css`

Il est servi automatiquement par FastAPI via `/static`, et la racine `/` charge `static/chatbot/index.html`.

## Docker

Une image Docker peut être construite via le `Dockerfile` fourni.

Exemple :

```bash
docker build -t chatbot-pdf .
docker run --env-file .env -p 8000:8000 chatbot-pdf
```
