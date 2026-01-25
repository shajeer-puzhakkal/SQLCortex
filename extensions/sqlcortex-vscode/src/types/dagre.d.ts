declare module "dagre" {
  const dagre: {
    graphlib: {
      Graph: new (options?: { multigraph?: boolean; compound?: boolean }) => any;
    };
    layout: (graph: any) => void;
  };
  export = dagre;
}
