import fs from 'fs';
import csvParser from 'csv-parser';


export const ParseCsv = async (file_path: string): Promise<any> => {

    try {
       return new Promise((resolve, reject) => {
        const results: Array<any> = [];

        fs.createReadStream(file_path)
        .pipe(csvParser([
            'id',
            'fname',
            'lname',
            'email',
            'add1',
            'add2',
            'add3',
            'add4'
        ]))
        .on('data', (data) => results.push({
            name: data.fname + " " + data.lname,
            email: data.email,
            address: `${data.add1} ${data.add2} ${data.add3} ${data.add4}`
        }))
        .on('end', async () => {
            // console.log(results)
            // return results
            resolve(results)
        })
       } )
        
    } catch (error) {
        throw Error('somethingw went wrong while parsing')
    }
}