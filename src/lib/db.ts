import { PrismaClient } from "../generated/prisma/client";

// @ts-ignore - Prisma 7.x types require adapter/accelerateUrl but runtime works with DATABASE_URL env var
const prisma = new PrismaClient({});

export default prisma;
