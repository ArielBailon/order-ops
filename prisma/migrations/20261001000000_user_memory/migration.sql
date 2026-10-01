-- CreateTable
CREATE TABLE "UserMemory" (
    "customerId" TEXT NOT NULL,
    "facts" TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserMemory_pkey" PRIMARY KEY ("customerId")
);

-- AddForeignKey
ALTER TABLE "UserMemory" ADD CONSTRAINT "UserMemory_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

