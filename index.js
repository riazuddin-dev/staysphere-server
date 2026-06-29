require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const cookieParser = require("cookie-parser");

const app = express();

app.use(
  cors({
    origin: [
      "https://property-platfrom.vercel.app",
      "http://localhost:3000",
    ],
    credentials: true,
  })
);

app.use(express.json());
app.use(cookieParser());

const client = new MongoClient(process.env.MONGO_DB, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    const db = client.db("staysphere");
    
    const userCollection = db.collection("user");
    const propertyCollection = db.collection("properties");
    const bookingCollection = db.collection("bookings");
    const favoriteCollection = db.collection("favorites");
    const reviewCollection = db.collection("reviews");
    const transactionCollection = db.collection("transactions");
    const sessionCollection = db.collection("session");

    app.get("/", (req, res) => {
      res.send("StaySphere Server Running 🚀");
    });

    console.log("✅ MongoDB Connected");
  } catch (error) {
    console.log(error);
  }
}

run().catch(console.dir);

const port = process.env.PORT || 5000;
app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});

const verifyToken = async (req, res, next) => {
  try {
    const sessionToken = req.cookies?.["better-auth.session_token"];
    
    if (!sessionToken) {
      return res.status(401).json({ message: "No session token" });
    }

    const actualToken = sessionToken.split('.')[0].substring(0, 32);
    const session = await sessionCollection.findOne({ token: actualToken });
    
    if (!session) {
      return res.status(403).json({ message: "Session not found" });
    }

    const user = await userCollection.findOne({ 
      _id: typeof session.userId === 'string' 
        ? new ObjectId(session.userId)
        : session.userId 
    });

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    req.user = {
      email: user.email,
      name: user.name,
      role: user.role || "tenant",
      image: user.image,
    };

    next();
  } catch (error) {
    return res.status(500).json({ message: "Authentication failed" });
  }
};

const verifyAdmin = (req, res, next) => {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ message: "Admin Access Only" });
  }
  next();
};

const verifyOwner = (req, res, next) => {
  if (req.user?.role !== "owner") {
    return res.status(403).json({ message: "Owner Access Only" });
  }
  next();
};

app.post("/save-user", async (req, res) => {
  try {
    const user = req.body;
    const existingUser = await userCollection.findOne({ email: user.email });

    if (existingUser) {
      if (!existingUser.role) {
        await userCollection.updateOne(
          { email: user.email },
          { $set: { role: "tenant" } }
        );
      }
      return res.send({ success: true });
    }

    await userCollection.insertOne({
      ...user,
      role: user.role || "tenant",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    res.send({ success: true });
  } catch (error) {
    res.status(500).send({ message: "Failed to save user" });
  }
});

app.get("/user-role/:email", async (req, res) => {
  try {
    const email = req.params.email;
    const user = await userCollection.findOne({ email });
    
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    
    res.send({ role: user.role || "tenant" });
  } catch (error) {
    res.status(500).send({ message: "Failed to fetch role" });
  }
});


app.get("/property/:id", async (req, res) => {
  try {
    const id = req.params.id;
    let query = ObjectId.isValid(id) 
      ? { _id: new ObjectId(id) } 
      : { _id: id };

    const result = await propertyCollection.findOne(query);

    if (!result) {
      return res.status(404).send({ message: "Property not found" });
    }

    res.send(result);
  } catch (error) {
    res.status(500).send({ message: "Server error" });
  }
});

app.get("/properties", async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 6;
    const skip = (page - 1) * limit;

    const search = req.query.search || "";
    const propertyType = req.query.propertyType || "all";
    const minPrice = parseInt(req.query.minPrice) || 0;
    const maxPrice = parseInt(req.query.maxPrice) || 999999;
    const sort = req.query.sort || "default";

    let query = { status: "approved" };

    if (search) {
      query.$or = [
        { title: { $regex: search, $options: "i" } },
        { location: { $regex: search, $options: "i" } },
      ];
    }

    if (propertyType !== "all") {
      query.propertyType = propertyType;
    }

    query.rent = { $gte: minPrice, $lte: maxPrice };

    let sortOption = {};
    if (sort === "low-high") sortOption = { rent: 1 };
    else if (sort === "high-low") sortOption = { rent: -1 };
    else sortOption = { createdAt: -1 };

    const total = await propertyCollection.countDocuments(query);
    const properties = await propertyCollection
      .find(query)
      .sort(sortOption)
      .skip(skip)
      .limit(limit)
      .toArray();

    res.send({
      total,
      page,
      totalPages: Math.ceil(total / limit),
      properties,
    });
  } catch (error) {
    res.status(500).send({ message: "Failed to load properties" });
  }
});

app.get("/dashboard-stats", verifyToken, async (req, res) => {
  try {
    const email = req.user.email;
    const role = req.user.role;

    if (role === "admin") {
      const totalUsers = await userCollection.countDocuments();
      const totalProperties = await propertyCollection.countDocuments();
      const totalBookings = await bookingCollection.countDocuments();
      
      const totalRevenueResult = await transactionCollection
        .aggregate([
          {
            $group: {
              _id: null,
              total: { $sum: { $toDouble: "$amount" } }
            }
          }
        ])
        .toArray();
      
      const totalRevenue = totalRevenueResult[0]?.total || 0;

      return res.send({
        role: "admin",
        totalUsers,
        totalProperties,
        totalBookings,
        totalRevenue,
      });
    }

    if (role === "owner") {
      const totalProperties = await propertyCollection.countDocuments({ ownerEmail: email });
      const totalBookings = await bookingCollection.countDocuments({ ownerEmail: email });
      
      const earningsResult = await transactionCollection
        .aggregate([
          { $match: { ownerEmail: email } },
          {
            $group: {
              _id: null,
              totalEarnings: { $sum: { $toDouble: "$amount" } }
            }
          }
        ])
        .toArray();

      const totalEarnings = earningsResult[0]?.totalEarnings || 0;

      return res.send({
        role: "owner",
        totalProperties,
        totalBookings,
        totalEarnings,
      });
    }

    if (role === "tenant") {
      const totalBookings = await bookingCollection.countDocuments({ tenantEmail: email });
      const totalFavorites = await favoriteCollection.countDocuments({ userEmail: email });

      return res.send({
        role: "tenant",
        totalBookings,
        totalFavorites,
      });
    }

    return res.status(400).send({ message: "Invalid Role" });
  } catch (error) {
    res.status(500).send({ message: "Server Error" });
  }
});


app.get("/users", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const result = await userCollection.find().toArray();
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: "Failed to fetch users" });
  }
});

app.patch("/users/role/:id", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const { role } = req.body;

    if (role === "admin") {
      return res.status(403).send({ message: "Cannot assign admin role" });
    }

    const result = await userCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { role } }
    );
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: "Failed to update role" });
  }
});

app.post("/properties", verifyToken, verifyOwner, async (req, res) => {
  try {
    const property = {
      ...req.body,
      ownerEmail: req.user.email,
      ownerName: req.user.name,
      status: "pending",
      createdAt: new Date(),
    };

    const result = await propertyCollection.insertOne(property);
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: "Failed to add property" });
  }
});

app.patch("/property/:id", verifyToken, verifyOwner, async (req, res) => {
  try {
    const id = req.params.id;
    const updatedData = req.body;

    const property = await propertyCollection.findOne({ _id: new ObjectId(id) });

    if (!property || property.ownerEmail !== req.user.email) {
      return res.status(403).send({ message: "Forbidden" });
    }

    const result = await propertyCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { ...updatedData, updatedAt: new Date() } }
    );
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: "Failed to update property" });
  }
});

app.delete("/properties/:id", verifyToken, verifyOwner, async (req, res) => {
  try {
    const id = req.params.id;
    const property = await propertyCollection.findOne({ _id: new ObjectId(id) });

    if (!property || property.ownerEmail !== req.user.email) {
      return res.status(403).send({ message: "Forbidden" });
    }

    const result = await propertyCollection.deleteOne({ _id: new ObjectId(id) });
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: "Failed to delete property" });
  }
});

app.get("/my-properties/:email", verifyToken, async (req, res) => {
  try {
    const email = req.params.email;

    if (req.user.email !== email && req.user.role !== "admin") {
      return res.status(403).send({ message: "Forbidden Access" });
    }

    const result = await propertyCollection.find({ ownerEmail: email }).toArray();
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: "Failed to fetch properties" });
  }
});

app.post("/bookings", verifyToken, async (req, res) => {
  try {
    const booking = req.body;

    if (booking.tenantEmail !== req.user.email) {
      return res.status(403).send({ message: "Forbidden Access" });
    }

    if (booking.ownerEmail === req.user.email) {
      return res.status(403).send({ message: "Cannot book your own property" });
    }

    const existing = await bookingCollection.findOne({
      propertyId: booking.propertyId,
      tenantEmail: req.user.email,
      status: { $in: ["pending", "approved"] },
    });

    if (existing) {
      return res.status(400).send({ message: "Booking already exists" });
    }

    const result = await bookingCollection.insertOne({
      ...booking,
      status: "pending",
      createdAt: new Date(),
    });
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: "Booking Failed" });
  }
});

app.get("/my-bookings", verifyToken, async (req, res) => {
  try {
    const bookings = await bookingCollection
      .find({ tenantEmail: req.user.email })
      .sort({ createdAt: -1 })
      .toArray();
    res.send(bookings);
  } catch (error) {
    res.status(500).send({ message: "Failed to fetch bookings" });
  }
});

app.get("/booking-requests/:ownerEmail", verifyToken, async (req, res) => {
  try {
    const ownerEmail = req.params.ownerEmail;

    if (req.user.email !== ownerEmail && req.user.role !== "admin") {
      return res.status(403).send({ message: "Forbidden Access" });
    }

    const result = await bookingCollection
      .find({ ownerEmail })
      .sort({ createdAt: -1 })
      .toArray();
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: "Failed to fetch bookings" });
  }
});

app.patch("/booking-status/:id", verifyToken, async (req, res) => {
  try {
    const id = req.params.id;
    const { status } = req.body;

    const booking = await bookingCollection.findOne({ _id: new ObjectId(id) });

    if (!booking) {
      return res.status(404).send({ message: "Booking not found" });
    }

    if (booking.ownerEmail !== req.user.email && req.user.role !== "admin") {
      return res.status(403).send({ message: "Forbidden" });
    }

    const result = await bookingCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { status, updatedAt: new Date() } }
    );
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: "Status update failed" });
  }
});

app.get("/all-bookings", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const result = await bookingCollection.find().toArray();
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: "Failed to fetch bookings" });
  }
});