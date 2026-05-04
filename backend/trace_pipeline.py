import sys, asyncio, time
sys.path.insert(0, "/app")

async def trace():
    t0 = time.time()

    print("1. Embedding...")
    from services.embeddings import embed_query
    loop = asyncio.get_running_loop()
    vec = await loop.run_in_executor(None, embed_query, "hola")
    print("Embedding OK, time=" + str(round(time.time()-t0, 1)) + "s dim=" + str(len(vec)))

    print("2. Qdrant search...")
    from core.database import get_qdrant_client
    q = get_qdrant_client()
    try:
        async with asyncio.timeout(2.0):
            results = await q.search(collection_name="demo_docs", query_vector=vec, limit=5, with_payload=True)
        print("Qdrant OK, time=" + str(round(time.time()-t0, 1)) + "s results=" + str(len(results)))
    except Exception as e:
        print("Qdrant ERROR time=" + str(round(time.time()-t0, 1)) + "s: " + type(e).__name__ + " " + str(e))

    print("3. Groq call...")
    from services.groq_client import complete, QueryComplexity
    try:
        async with asyncio.timeout(10):
            ans = await complete([{"role": "user", "content": "hola"}], complexity=QueryComplexity.SIMPLE)
        print("Groq OK, time=" + str(round(time.time()-t0, 1)) + "s: " + ans[:80])
    except Exception as e:
        print("Groq ERROR time=" + str(round(time.time()-t0, 1)) + "s: " + type(e).__name__ + " " + str(e))

asyncio.run(trace())
