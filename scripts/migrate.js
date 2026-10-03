import { closeDatabase, initializeDatabase } from '../src/db.js'

initializeDatabase()
closeDatabase()
console.log('Database migrations applied.')
