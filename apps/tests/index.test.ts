// //unit ests vs integration tests
// //benefit of writing integration test is that we take our codebase to ts to rust , can be resued
// describe("auth endpoints",()=>{
//   it("signup doesnt work if username isnnt provided",async ()=>{
    
//     try{
//       const reponse = await axios.post(`${BACKEND}/api/v1/signup`,{
//         password:"123123"
//       })
//       expect(1).toBe(411);
//     }catch(e:){
//       expect(e.response.status).toBe(411);
//     }
//   })
// })