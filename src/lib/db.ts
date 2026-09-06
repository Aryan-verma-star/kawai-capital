import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['error'], // query logging off in production; the flight recorder is the audit trail
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db