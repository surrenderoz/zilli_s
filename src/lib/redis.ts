import Redis from "ioredis";

// Create Redis client. Default connects to localhost:6379.
// Uses REDIS_URL from .env if available.
const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");

redis.on("error", (err) => {
    console.error("Redis error:", err);
});

export default redis;
