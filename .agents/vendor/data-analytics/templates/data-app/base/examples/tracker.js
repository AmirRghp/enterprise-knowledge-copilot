const groups = [
  {
    label: "Defaults",
    examples: [
      { name: "Base template", href: "./base-template/", path: "/examples/base-template/" },
      { name: "Neutral starter", href: "./neutral-starter/", path: "/examples/neutral-starter/" },
      { name: "Main report", href: "./main-report/", path: "/examples/main-report/" },
      { name: "Component Lab", href: "./component-lab/", path: "/examples/component-lab/" },
    ],
  },
  {
    label: "Enterprise",
    examples: [
      { name: "Lattice product growth", href: "./product-tracker/", path: "/examples/product-tracker/" },
      { name: "Northstar business performance", href: "./business-performance/", path: "/examples/business-performance/" },
      { name: "Aster Compute capacity", href: "./infrastructure-capacity/", path: "/examples/infrastructure-capacity/" },
      { name: "Acme Cloud automation usage", href: "./acme-workflow/", path: "/examples/acme-workflow/" },
    ],
  },
  {
    label: "SMB",
    examples: [
      { name: "Harbor Logistics operations", href: "./fleet-operations/", path: "/examples/fleet-operations/" },
    ],
  },
  {
    label: "Prosumer",
    examples: [
      { name: "Stock watch", href: "./finance/", path: "/examples/finance/" },
    ],
  },
];

const rows = document.getElementById("example-rows");
const copyIcon = `
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <rect x="6.5" y="6.5" width="9" height="9" rx="1.5"></rect>
    <path d="M13.5 6.5v-1A1.5 1.5 0 0 0 12 4H5.5A1.5 1.5 0 0 0 4 5.5V12A1.5 1.5 0 0 0 5.5 13.5h1"></path>
  </svg>`;
const checkIcon = `
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <path d="m5 10 3 3 7-7"></path>
  </svg>`;

function createGroupRow(label) {
  const row = document.createElement("tr");
  row.className = "group-row";
  row.innerHTML = `<th colspan="3" scope="rowgroup">${label}</th>`;
  return row;
}

function createExampleRow(example) {
  const row = document.createElement("tr");
  row.className = "example-row";
  row.innerHTML = `
    <td><a class="example-name" href="${example.href}">${example.name}</a></td>
    <td><a class="example-url" href="${example.href}">${example.path}</a></td>
    <td>
      <button class="copy-url" type="button" aria-label="Copy ${example.name} URL" title="Copy URL">
        ${copyIcon}
      </button>
    </td>`;

  row.querySelector(".copy-url").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    await navigator.clipboard.writeText(new URL(example.href, window.location.href).href);
    button.innerHTML = checkIcon;
    button.dataset.copied = "true";
    button.title = "Copied";
    window.setTimeout(() => {
      button.innerHTML = copyIcon;
      button.dataset.copied = "false";
      button.title = "Copy URL";
    }, 1400);
  });
  return row;
}

for (const group of groups) {
  rows.appendChild(createGroupRow(group.label));
  for (const example of group.examples) rows.appendChild(createExampleRow(example));
}
