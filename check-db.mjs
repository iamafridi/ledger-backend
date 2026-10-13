import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  const expenses = await db.collection("expenses").find({}).limit(10).toArray();
  console.log("Sample expenses:", expenses.map(e => ({ id: e._id, uid: e.uid, shop: e.shop, amount: e.amount_bdt, date: e.date, category: e.category })));

  const orgMemberships = await db.collection("orgmemberships").find({}).toArray();
  console.log("Org memberships:", orgMemberships);

  const organizations = await db.collection("organizations").find({}).toArray();
  console.log("Organizations:", organizations);

  const users = await db.collection("users").find({}).toArray();
  console.log("Users:", users);

  await mongoose.disconnect();
}

main().catch(console.error);
