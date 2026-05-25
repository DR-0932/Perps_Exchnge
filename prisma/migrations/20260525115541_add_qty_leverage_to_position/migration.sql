/*
  Warnings:

  - Added the required column `leverage` to the `Position` table without a default value. This is not possible if the table is not empty.
  - Added the required column `qty` to the `Position` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Position" ADD COLUMN     "leverage" INTEGER NOT NULL,
ADD COLUMN     "qty" INTEGER NOT NULL;
