const express = require('express');
const app = express();
const cors = require('cors');
const jwt = require('jsonwebtoken');
require('dotenv').config();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const formData=require('form-data')
const Mailgun=require('mailgun.js')
const mailgun=new Mailgun(formData)

 const mg = mailgun.client({
    username: "api",
    key: process.env.PRIVATE_API_KEY,
    // When you have an EU-domain, you must specify the endpoint:
    // url: "https://api.eu.mailgun.net"
  });
const port = process.env.PORT || 5000;

// middleware
app.use(cors());
app.use(express.json());

const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.ieavp.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();

    const menuCollection = client.db("bistroDb").collection("menu");
    const reviewCollection = client.db("bistroDb").collection("reviews");
    const cartCollection = client.db("bistroDb").collection("carts");
    const userCollection = client.db("bistroDb").collection("users");
    const paymentCollection = client.db("bistroDb").collection("payments");
    const verifyToken = (req, res, next) => {
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return res.status(401).send({ message: 'forbidden access' });
      }
      const token = authHeader.split(' ')[1];
      jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (err, decoded) => {
        if (err) {
          return res.status(401).send({ message: 'forbidden access' });
        }
        req.decoded = decoded;
        next();
      });
    };

    const verifyAdmin = async (req, res, next) => {
      try {
        const email = req.decoded?.email;
        if (!email) {
          return res.status(403).send({ message: 'forbidden access' });
        }
        const user = await userCollection.findOne({ email });
        if (!user || user.role !== 'admin') {
          return res.status(403).send({ message: 'forbidden access' });
        }
        next();
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: 'server error' });
      }
    };


    // stats or analytics
    app.get('/admin-stats', verifyToken, verifyAdmin, async (req, res) => {
      const users = await userCollection.estimatedDocumentCount();
      const menuItems = await menuCollection.estimatedDocumentCount();
      const orders = await paymentCollection.estimatedDocumentCount();

      // this is not the best way
      // const payments = await paymentCollection.find().toArray();
      // const revenue = payments.reduce((total, payment) => total + payment.price, 0);

      const result = await paymentCollection.aggregate([
        {
          $group: {
            _id: null,
            totalRevenue: {
              $sum: '$price'
            }
          }
        }
      ]).toArray();

      const revenue = result.length > 0 ? result[0].totalRevenue : 0;

      res.send({
        users,
        menuItems,
        orders,
        revenue
      })
    })
    // using aggregate pipeline
    app.get('/order-stats', verifyToken, verifyAdmin, async(req, res) =>{
      const result = await paymentCollection.aggregate([
        {
          $unwind: '$menuItemIds'
        },
        {
          $lookup: {
            from: 'menu',
            localField: 'menuItemIds',
            foreignField: '_id',
            as: 'menuItems'
          }
        },
        {
          $unwind: '$menuItems'
        },
        {
          $group: {
            _id: '$menuItems.category',
            quantity:{ $sum: 1 },
            revenue: { $sum: '$menuItems.price'} 
          }
        },
        {
          $project: {
            _id: 0,
            category: '$_id',
            quantity: '$quantity',
            revenue: '$revenue'
          }
        }
      ]).toArray();

      res.send(result);

    })


    // JWT related
    app.post('/jwt', async (req, res) => {
      const user = req.body;
      const token = jwt.sign(user, process.env.ACCESS_TOKEN_SECRET, { expiresIn: '1h' });
      res.send({ token });
    });

   

    // Payment Intent
    app.post('/create-payment-intent', async (req, res) => {
      const { price } = req.body;
      const amount = Math.round(price * 100);
      const paymentIntent = await stripe.paymentIntents.create({
        amount,
        currency: 'usd',
        payment_method_types: ['card'],
      });
      res.send({ clientSecret: paymentIntent.client_secret });
    });

    app.post('/payments', async (req, res) => {
      const payment = req.body;
      const paymentResult = await paymentCollection.insertOne(payment);
      const query = { _id: { $in: payment.cartIds.map(id => new ObjectId(id)) } };
      const deleteResult = await cartCollection.deleteMany(query);
      mg.messages.create(process.env.MAIL_SENDING_DOMAIN, {
      from: "Mailgun Sandbox <postmaster@sandbox7b3685dbdabd4dbc97df5d8ef76a38cb.mailgun.org>",
      to: ["Md.Salman Rahman Nayeem <salmanrahman339@gmail.com>"],
      subject: "Hello Md.Salman Rahman Nayeem",
      text: "Congratulations Md.Salman Rahman Nayeem, you just sent an email with Mailgun! You are truly awesome!",
        html: `
            <div>
              <h2>Thank you for your order</h2>
              <h4>Your Transaction Id: <strong>${payment.transactionId}</strong></h4>
              <p>We would like to get your feedback about the food</p>
            </div>
          `
    })
        .then(msg => console.log(msg)) 
        .catch(err => console.log(err)); 
      res.send({ paymentResult, deleteResult });
    });

    // Payments by user
    app.get('/payments/:email', verifyToken, async (req, res) => {
      const { email } = req.params;
      if (email !== req.decoded.email) {
        return res.status(403).send({ message: 'forbidden access' });
      }
      const result = await paymentCollection.find({ email }).toArray();
      res.send(result);
    });

    // Users API
    app.post('/users', async (req, res) => {
      const user = req.body;
      const existingUser = await userCollection.findOne({ email: user.email });
      if (existingUser) {
        return res.send({ message: 'user already exists', insertedId: null });
      }
      const result = await userCollection.insertOne(user);
      res.send(result);
    });

    app.get('/users', verifyToken, verifyAdmin, async (req, res) => {
      const result = await userCollection.find().toArray();
      res.send(result);
    });

    app.patch('/users/admin/:id', verifyToken, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const filter = { _id: new ObjectId(id) };
      const updatedDoc = { $set: { role: 'admin' } };
      const result = await userCollection.updateOne(filter, updatedDoc);
      res.send(result);
    });

    app.delete('/users/:id', async (req, res) => {
      const id = req.params.id;
      const result = await userCollection.deleteOne({ _id: new ObjectId(id) });
      res.send(result);
    });

    app.get('/users/admin/:email', verifyToken, async (req, res) => {
      const email = req.params.email;
      if (email !== req.decoded.email) {
        return res.status(403).send({ message: 'unauthorized access' });
      }
      const user = await userCollection.findOne({ email });
      const admin = user?.role === 'admin';
      res.send({ admin });
    });

    // Carts API
    app.post('/carts', async (req, res) => {
      const result = await cartCollection.insertOne(req.body);
      res.send(result);
    });

    app.get('/carts', async (req, res) => {
      const email = req.query.email;
      const result = await cartCollection.find({ email }).toArray();
      res.send(result);
    });

    app.delete('/carts/:id', async (req, res) => {
      const id = req.params.id;
      const result = await cartCollection.deleteOne({ _id: new ObjectId(id) });
      res.send(result);
    });

    // Menu API
    app.get('/menu', async (req, res) => {
      const result = await menuCollection.find().toArray();
      res.send(result);
    });

    app.get('/menu/:id', async (req, res) => {
      const id = req.params.id;
      const result = await menuCollection.findOne({ _id: new ObjectId(id) });
      res.send(result);
    });

    app.patch('/menu/:id', async (req, res) => {
      const id = req.params.id;
      const item = req.body;
      const updatedDoc = {
        $set: {
          name: item.name,
          category: item.category,
          price: item.price,
          recipe: item.recipe,
          image: item.image,
        },
      };
      const result = await menuCollection.updateOne({ _id: new ObjectId(id) }, updatedDoc);
      res.send(result);
    });

    app.post('/menu', verifyToken, verifyAdmin, async (req, res) => {
      const result = await menuCollection.insertOne(req.body);
      res.send(result);
    });

    app.delete('/menu/:id', verifyToken, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const result = await menuCollection.deleteOne({ _id: new ObjectId(id) });
      res.send(result);
    });

    app.get('/reviews', async (req, res) => {
      const result = await reviewCollection.find().toArray();
      res.send(result);
    });

    console.log("Connected to MongoDB!");
  } finally {
    // Do not close client here to keep the server alive
  }
}

run().catch(console.dir);

app.get('/', (req, res) => {
  res.send('Boss is sitting');
});

app.listen(port, () => {
  console.log(`Bistro boss is sitting on port ${port}`);
});
