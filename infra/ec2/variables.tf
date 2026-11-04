variable "project" {
  type    = string
  default = "building-management"
}

# ARM (Graviton), 2 vCPU / 1 GiB. Free plan'da kullanilabilen en ucuz tip.
variable "instance_type" {
  type    = string
  default = "t4g.micro"
}
