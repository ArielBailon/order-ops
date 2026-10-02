-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('customer', 'operator');

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "role" "UserRole" NOT NULL DEFAULT 'customer';

-- AlterTable
ALTER TABLE "RefundRequest" ADD COLUMN     "threadKey" TEXT;
