import fs from 'fs';
import csvParser from 'csv-parser';


export const ParseCsv = async (file_path: string): Promise<any> => {

    try {
        return new Promise((resolve, reject) => {
            const results: Array<any> = [];

            fs.createReadStream(file_path)
                .pipe(csvParser({ headers: false }))
                .on('data', (data) => {
                    const keys = Object.keys(data);
                    // Check for 8 columns (Snipper format)
                    if (keys.length >= 8) {
                        results.push({
                            name: `${data[1]} ${data[2]}`,
                            email: data[3],
                            address: `${data[4]} ${data[5]} ${data[6]} ${data[7]}`
                        });
                    }
                    // Check for 5 columns (Data.csv format)
                    else if (keys.length >= 5) {
                        results.push({
                            name: data[1],
                            email: data[2],
                            address: data[3]
                        });
                    }
                    // Fallback or ignore
                    else {
                        // Try best effor map if needed, or skip
                    }
                })
                .on('end', async () => {
                    resolve(results)
                })
        })

    } catch (error) {
        throw Error('somethingw went wrong while parsing')
    }
}