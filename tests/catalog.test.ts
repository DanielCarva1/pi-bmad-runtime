import { describe, expect, it } from "vitest";
import { findCatalogRow, parseBmadCatalog } from "../extensions/bmad-runtime/catalog.js";

const csv = `module,skill,display-name,menu-code,description,action,args,phase,after,before,required,output-location,outputs
BMad Method,_meta,,,,,,,,,false,https://docs.bmad-method.org/llms.txt,
BMad Method,bmad-create-prd,Create PRD,CP,Create requirements.,,,2-planning,,,true,planning_artifacts,prd
BMad Method,bmad-create-architecture,Create Architecture,CA,Create architecture.,,,3-solutioning,bmad-create-prd,,true,planning_artifacts,architecture
BMad Method,bmad-product-brief,Create Brief,CB,"Brief, with comma",,-A,1-analysis,,,false,planning_artifacts,product brief
`;

describe("BMAD catalog parser", () => {
  it("parses rows and skips meta rows", () => {
    const rows = parseBmadCatalog(csv);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ skill: "bmad-create-prd", menuCode: "CP", required: true });
    expect(rows[2]?.description).toBe("Brief, with comma");
    expect(rows[2]?.args).toBe("-A");
  });

  it("finds rows by menu code, skill, or display name", () => {
    const rows = parseBmadCatalog(csv);
    expect(findCatalogRow(rows, "CP")?.skill).toBe("bmad-create-prd");
    expect(findCatalogRow(rows, "bmad-create-architecture")?.menuCode).toBe("CA");
    expect(findCatalogRow(rows, "Create Brief")?.skill).toBe("bmad-product-brief");
  });
});
