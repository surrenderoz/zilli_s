import { Elysia } from 'elysia'
import { swagger } from '@elysiajs/swagger'
import Service from "./api/upload";


const app = new Elysia();

app.use(Service)
// app.use(staticPlugin({ assets: 'public' }))
app.get("/", () => Bun.file("public/index.html"))
    .use(swagger())
    .listen(3006);

// ParseCsv()   


// main()