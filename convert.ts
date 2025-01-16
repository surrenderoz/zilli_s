import excelJS from "exceljs";
const data = require("./found.json")


const workbook = new excelJS.Workbook();
const worksheet = workbook.addWorksheet("Sheet");

const path = "./files";


worksheet.columns = [
    { header: "S no.", key: "s_no", width: 10 },
    { header: "Name", key: "name", width: 10 }, 
    { header: "Email", key: "email", width: 20 },
    { header: "Address", key: "address", width: 30 },
    { header: "Estimate", key: "estimate", width: 20 },
];

let counter = 1;

let arr: Array<any> = data.data;

// arr = arr.reduce((a, b) => a - b)
// console.log(arr, "arr");

arr.forEach((user) => {
    user.s_no = counter;
    worksheet.addRow(user); // Add data in worksheet
    counter++;
  });

  worksheet.getRow(1).eachCell((cell) => {
    cell.font = { bold: true };
  });


  const _data = await workbook.xlsx.writeFile(`${path}/users.xlsx`)