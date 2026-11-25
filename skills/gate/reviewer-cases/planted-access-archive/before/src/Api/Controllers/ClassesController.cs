using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using School.Application.Classes;

namespace School.Api.Controllers;

[ApiController]
[Route("api/classes")]
[Authorize]
public class ClassesController : ControllerBase
{
    private readonly IClassService _classes;

    public ClassesController(IClassService classes) => _classes = classes;

    [HttpGet]
    public async Task<IActionResult> List([FromQuery] int page = 1, CancellationToken ct = default)
        => Ok(await _classes.ListAsync(User.SchoolIds(), page, ct));

    [HttpPost]
    [Authorize(Roles = "Admin,Manager")]
    public async Task<IActionResult> Create([FromBody] CreateClassDto dto, CancellationToken ct)
    {
        var created = await _classes.CreateAsync(dto, User.SchoolIds(), ct);
        return CreatedAtAction(nameof(List), new { id = created.Id }, created);
    }

    [HttpPut("{id:int}")]
    [Authorize(Roles = "Admin,Manager")]
    public async Task<IActionResult> Update(int id, [FromBody] UpdateClassDto dto, CancellationToken ct)
    {
        await _classes.UpdateAsync(id, dto, User.SchoolIds(), ct);
        return NoContent();
    }
}
