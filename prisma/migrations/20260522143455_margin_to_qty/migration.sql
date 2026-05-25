/*
  Warnings:

  - You are about to drop the column `margin` on the `Orders` table. All the data in the column will be lost.
  - Added the required column `maker_order_id` to the `Fills` table without a default value. This is not possible if the table is not empty.
  - Added the required column `market_id` to the `Fills` table without a default value. This is not possible if the table is not empty.
  - Added the required column `taker_order_id` to the `Fills` table without a default value. This is not possible if the table is not empty.
  - Added the required column `qty` to the `Orders` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Fills" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "maker_order_id" INTEGER NOT NULL,
ADD COLUMN     "market_id" TEXT NOT NULL,
ADD COLUMN     "taker_order_id" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "Orders" DROP COLUMN "margin",
ADD COLUMN     "qty" INTEGER NOT NULL;
