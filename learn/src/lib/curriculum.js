// talvi-learn curriculum (decision 4 / decision 5). Content is static JSON
// bundled by esbuild — never a database. PR5 (NID-100) authors the real Units
// 1–4 and gates Unit 5; until it lands, GET /learn/api/curriculum serves this
// stable placeholder shape so the API contract is fixed and PR5 only fills
// data. The shape mirrors what PR5 fills: units[] → lessons[] → exercises[].
//
// import u1 from "../../curriculum/u1.json";
// const UNITS = [u1, ...];
export function getCurriculum() {
  return {
    version: 0,
    units: [],
    note: "placeholder — curriculum content lands in PR5",
  };
}
